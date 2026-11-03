#!/usr/bin/env python3
"""使用 libclang 提取 C++ 代码中调用的函数"""

import clang.cindex as ci
import json
import os
import re
import sys
from typing import TypedDict, Optional


STDLIB_NAMES = frozenset({
    '__va_list_tag',
})


class CalleeInfo(TypedDict):
    name: str
    class_name: str | None
    is_internal: bool
    defined_in_file: str | None
    defined_at_line: int | None
    is_member: bool
    declared_in_header: bool


class CppCallExtractor:
    _libclang_initialized = False

    def __init__(self, libclang_path: 'Optional[str]' = None):
        self.libclang_path = libclang_path
        self._ensure_libclang_initialized()

    def _ensure_libclang_initialized(self):
        if CppCallExtractor._libclang_initialized:
            return
        if self.libclang_path is None:
            self.libclang_path = self._find_libclang()
        if not os.path.exists(self.libclang_path):
            raise FileNotFoundError(f"libclang.so not found at {self.libclang_path}")
        ci.Config.set_library_file(self.libclang_path)
        CppCallExtractor._libclang_initialized = True

    def _find_libclang(self) -> str:
        import subprocess
        import glob as glob_module
        is_windows = sys.platform == 'win32'
        libclang_name = 'libclang.dll' if is_windows else 'libclang.so'
        try:
            result = subprocess.run(['llvm-config', '--libdir'], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                libdir = result.stdout.strip()
                so_path = os.path.join(libdir, libclang_name)
                if os.path.exists(so_path):
                    return so_path
        except (subprocess.SubprocessError, FileNotFoundError):
            pass
        if is_windows:
            search_paths = [
                os.path.join(os.environ.get('ProgramFiles', r'C:\Program Files'), 'LLVM', 'bin', 'libclang.dll'),
                os.path.join(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'), 'LLVM', 'bin', 'libclang.dll'),
                os.path.join(os.environ.get('MSYS2_ROOT', r'C:\msys64'), 'mingw64', 'bin', 'libclang.dll'),
                os.path.join(os.environ.get('MSYS2_ROOT', r'C:\msys64'), 'ucrt64', 'bin', 'libclang.dll'),
            ]
            env_path = os.environ.get('LLVM_INSTALL_DIR', '')
            if env_path:
                search_paths.insert(0, os.path.join(env_path, 'bin', 'libclang.dll'))
            for path in search_paths:
                if os.path.exists(path):
                    return path
        else:
            search_paths = [
                '/usr/lib/llvm*/lib/libclang.so',
                '/usr/lib64/llvm*/lib/libclang.so',
                '/opt/buildtools/llvm-*/lib/libclang.so',
            ]
            for pattern in search_paths:
                matches = glob_module.glob(pattern)
                if matches:
                    return sorted(matches)[-1]
        raise FileNotFoundError(f"Cannot find {libclang_name}, please specify --libclang-path")

    def _find_clang_resource_dir(self) -> Optional[str]:
        import subprocess
        import glob as glob_module
        is_windows = sys.platform == 'win32'
        try:
            result = subprocess.run(['llvm-config', '--prefix'], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                prefix = result.stdout.strip()
                clang_include_pattern = os.path.join(prefix, 'lib', 'clang', '*', 'include')
                matches = glob_module.glob(clang_include_pattern)
                if matches:
                    return os.path.dirname(matches[0])
        except (subprocess.SubprocessError, FileNotFoundError):
            pass
        libclang_path = self.libclang_path or self._find_libclang()
        if libclang_path:
            clang_include = os.path.join(os.path.dirname(os.path.dirname(libclang_path)), 'lib', 'clang', '*', 'include')
            matches = glob_module.glob(clang_include)
            if matches:
                return os.path.dirname(matches[0])
        if is_windows:
            search_paths = []
            llvm_dir = os.environ.get('LLVM_INSTALL_DIR', '')
            if llvm_dir:
                search_paths.append(os.path.join(llvm_dir, 'lib', 'clang', '*', 'include'))
            program_files = os.environ.get('ProgramFiles', r'C:\Program Files')
            search_paths.append(os.path.join(program_files, 'LLVM', 'lib', 'clang', '*', 'include'))
            for pattern in search_paths:
                matches = glob_module.glob(pattern)
                if matches:
                    return os.path.dirname(matches[-1])
        else:
            search_paths = [
                '/opt/buildtools/llvm-*/lib/clang/*/include',
                '/usr/lib/llvm*/lib/clang/*/include',
            ]
            for pattern in search_paths:
                matches = glob_module.glob(pattern)
                if matches:
                    return os.path.dirname(matches[-1])
        return None

    def _is_stdlib_name(self, name: str) -> bool:
        if not name:
            return True
        if name.startswith('operator'):
            return True
        for prefix in STDLIB_NAMES:
            if name.startswith(prefix):
                return True
        return False

    def _is_system_location(self, cursor) -> bool:
        try:
            loc = cursor.location
            if loc and loc.file:
                filename = loc.file.name
                if filename:
                    abs_path = os.path.realpath(filename)
                    if sys.platform == 'win32':
                        abs_path_lower = abs_path.lower()
                        system_dirs = [
                            os.environ.get('ProgramFiles', r'C:\Program Files').lower(),
                            os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)').lower(),
                            os.environ.get('SystemRoot', r'C:\Windows').lower(),
                        ]
                        for d in system_dirs:
                            if abs_path_lower.startswith(d):
                                return True
                    else:
                        if abs_path.startswith('/usr/') or abs_path.startswith('/opt/'):
                            return True
        except Exception:
            pass
        return False

    def _is_valid_function_call(self, cursor) -> bool:
        try:
            kind = cursor.kind
        except Exception:
            return False
        valid_kinds = [
            ci.CursorKind.CALL_EXPR,
            ci.CursorKind.CXX_METHOD,
            ci.CursorKind.OVERLOADED_DECL_REF,
            ci.CursorKind.TEMPLATE_REF,
        ]
        cxx_member_call = getattr(ci.CursorKind, 'CXX_MEMBER_CALL_EXPR', None)
        if cxx_member_call is not None:
            valid_kinds.append(cxx_member_call)
        if kind not in valid_kinds:
            return False
        callee = cursor.referenced
        if not callee or not callee.spelling:
            return False
        if callee.kind == ci.CursorKind.CONSTRUCTOR:
            return False
        return True

    def _is_member_function(self, cursor) -> bool:
        callee = cursor.referenced
        if not callee:
            return False
        valid_member_kinds = [ci.CursorKind.CXX_METHOD, ci.CursorKind.OVERLOADED_DECL_REF]
        return callee.kind in valid_member_kinds

    def _get_compile_args(self, file_path: str, compile_commands_path: str) -> list[str]:
        if not compile_commands_path:
            return []
        with open(compile_commands_path, 'r') as f:
            compile_commands = json.load(f)
        for entry in compile_commands:
            if os.path.normpath(entry['file']) == os.path.normpath(file_path):
                cmd = entry['command']
                args = re.findall(r'(?:[^\s,"]|"(?:[^"\\]|\\.)*")+', cmd)
                compile_args = args[1:]
                filtered = []
                skip_next = False
                for arg in compile_args:
                    if skip_next:
                        skip_next = False
                        continue
                    # -c: 编译选项（只编译不链接），clang 不需要
                    if arg in ('-c', '-o', '-Winvalid-pch'):
                        skip_next = True
                        continue
                    # -include: 预编译头，GCC PCH 与 clang 不兼容
                    if arg == '-include':
                        skip_next = True
                        continue
                    # -Wl: linker 选项，传递给链接器，clang 解析时不需要
                    if arg.startswith('-Wl,') or arg == '-Wl':
                        continue
                    # PCH 文件: GCC 预编译头，clang 无法使用
                    if arg.endswith('.hxx') or arg.endswith('.h.gch') or arg.endswith('.pch'):
                        continue
                    filtered.append(arg)
                return filtered
        return []

    def _get_parent_class_name(self, cursor) -> str:
        parent = cursor.semantic_parent
        while parent:
            if parent.kind in (ci.CursorKind.CLASS_DECL, ci.CursorKind.STRUCT_DECL):
                return parent.spelling
            parent = parent.semantic_parent
        return ""

    def _is_in_function_ranges(self, cursor_loc, func_ranges) -> bool:
        if not func_ranges:
            return False
        if not cursor_loc or not cursor_loc.file:
            return False
        cursor_file = os.path.realpath(cursor_loc.file.name)
        for func_start, func_end, _, _ in func_ranges:
            func_file = os.path.realpath(func_start.file.name)
            if cursor_file != func_file:
                continue
            if cursor_loc.line < func_start.line:
                continue
            if cursor_loc.line == func_start.line and cursor_loc.column < func_start.column:
                continue
            if cursor_loc.line > func_end.line:
                continue
            if cursor_loc.line == func_end.line and cursor_loc.column > func_end.column:
                continue
            return True
        return False

    def _parse_source(self, source_code: str, filename: str, compile_commands_path: str) -> ci.TranslationUnit:
        index = ci.Index.create()
        args = ['-std=c++17', '-fsyntax-only']
        if compile_commands_path:
            compile_args = self._get_compile_args(filename, compile_commands_path)
            if compile_args:
                args = compile_args
        return index.parse(filename, args=args, unsaved_files=[(filename, source_code)])

    def _should_skip_callee(self, node, func_ranges, callee, name, callee_info) -> bool:
        """判断是否应该跳过该函数调用"""
        # 调用位置不在目标函数范围内
        if not self._is_in_function_ranges(node.location, func_ranges):
            return True
        # 系统位置或标准库函数
        if self._is_system_location(callee) or self._is_stdlib_name(name):
            return True
        # 已处理过，避免重复
        if name in callee_info:
            return True
        return False

    def _get_callee_definition_location(self, callee, local_defs, callee_class=None) -> tuple:
        """获取被调用函数的定义位置（文件 + 行号）"""
        declared_in_file = None
        declared_at_line = None
        if callee.location and callee.location.file:
            declared_in_file = callee.location.file.name
            declared_at_line = callee.location.line
        def_key = f"{callee_class}::{callee.spelling}" if callee_class else callee.spelling
        if def_key in local_defs:
            return local_defs[def_key]
        return declared_in_file, declared_at_line

    def _process_call_expr(self, node, func_ranges: list[tuple], filename: str,
                           func_class: str, callee_info: dict[str, CalleeInfo],
                           local_defs: dict[str, tuple]):
        callee = node.referenced
        name = callee.spelling
        if self._should_skip_callee(node, func_ranges, callee, name, callee_info):
            return
        is_member = self._is_member_function(node)
        callee_class = self._get_parent_class_name(callee) if is_member else None
        defined_in_file, defined_at_line = self._get_callee_definition_location(callee, local_defs, callee_class)
        def_key = f"{callee_class}::{name}" if callee_class else name
        is_defined_locally = def_key in local_defs
        is_same_class = is_member and bool(func_class) and callee_class == func_class
        declared_in_header = defined_in_file.endswith('.h') if defined_in_file else False
        callee_info[name] = CalleeInfo(
            name=name,
            class_name=callee_class,
            is_internal=is_defined_locally or is_same_class,
            defined_in_file=defined_in_file,
            defined_at_line=defined_at_line,
            is_member=is_member,
            declared_in_header=declared_in_header
        )

    def _parse_and_collect(self, source_code: str, filename: str,
                           compile_commands_path: str, target_line: int) -> tuple[dict[str, CalleeInfo], str]:
        index = ci.Index.create()
        args = ['-std=c++17', '-fsyntax-only', '-ferror-limit=0']
        if compile_commands_path:
            compile_args = self._get_compile_args(filename, compile_commands_path)
            if compile_args:
                args = compile_args + ['-ferror-limit=0']
        if not any('resource-dir' in a for a in args):
            resource_dir = self._find_clang_resource_dir()
            if resource_dir:
                args = ['-resource-dir', resource_dir] + args
        tu = index.parse(filename, args=args, unsaved_files=[(filename, source_code)])

        local_defs: dict[str, tuple] = {}
        func_ranges: list[tuple] = []
        func_class = ""
        all_call_exprs: list = []

        for node in tu.cursor.walk_preorder():
            if node.kind in (ci.CursorKind.CXX_METHOD, ci.CursorKind.FUNCTION_DECL, ci.CursorKind.CONSTRUCTOR, ci.CursorKind.FUNCTION_TEMPLATE):
                loc = node.location
                same_file = loc and loc.file and os.path.normpath(loc.file.name) == os.path.normpath(filename)
                at_target_line = loc.line == target_line if loc else False
                if same_file:
                    func_name = node.spelling
                    if func_name:
                        node_class = self._get_parent_class_name(node)
                        def_key = f"{node_class}::{func_name}" if node_class else func_name
                        local_defs[def_key] = (loc.file.name, loc.line)
                if same_file and at_target_line:
                    func_range = node.extent
                    if func_range:
                        func_class = self._get_parent_class_name(node)
                        func_ranges = [(func_range.start, func_range.end, None, None)]
            elif self._is_valid_function_call(node) and func_ranges:
                all_call_exprs.append(node)

        callee_info: dict[str, CalleeInfo] = {}
        for node in all_call_exprs:
            self._process_call_expr(node, func_ranges, filename, func_class, callee_info, local_defs)

        return callee_info, func_class

    def callees(self, source_code: str, filename: str,
                compile_commands_path: str = "",
                target_line: int = 0) -> tuple[list[CalleeInfo], str]:
        if target_line <= 0:
            raise ValueError("target_line must be specified")
        abs_filename = os.path.abspath(filename)
        callee_info, func_class = self._parse_and_collect(source_code, abs_filename, compile_commands_path, target_line)
        return list(callee_info.values()), func_class


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='提取 C++ 函数调用的函数')
    parser.add_argument('source_file', help='源文件路径')
    parser.add_argument('--compile-commands', '-c', default='', help='compile_commands.json 路径')
    parser.add_argument('--libclang-path', '-L', default=None, help='libclang.so 路径')
    parser.add_argument('--line', '-l', type=int, required=True, help='函数所在行号')
    args = parser.parse_args()

    if not args.compile_commands or not os.path.isfile(args.compile_commands):
        print(f"错误: compile_commands.json 文件不存在: {args.compile_commands}")
        print("请检查路径是否正确")
        exit(1)

    with open(args.source_file, 'r', encoding='utf-8', errors='ignore') as f:
        source_code = f.read()

    extractor = CppCallExtractor(libclang_path=args.libclang_path)
    result, func_class = extractor.callees(
        source_code,
        args.source_file,
        compile_commands_path=args.compile_commands,
        target_line=args.line
    )
    callee_list: list[CalleeInfo] = result

    if not callee_list:
        print("无函数调用")
    for item in callee_list:
        location = f"{item['defined_in_file']}:{item['defined_at_line']}"
        tag = "(内部依赖)" if item['is_internal'] else "(外部依赖)"
        extra = ""
        if item['is_internal'] and item['declared_in_header']:
            extra = " [需查找实现位置]"
        class_prefix = f"{item['class_name']}::" if item['class_name'] else ""
        print(f"{class_prefix}{item['name']} {location} {tag}{extra}")
