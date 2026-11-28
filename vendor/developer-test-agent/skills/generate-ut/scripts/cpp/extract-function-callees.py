#!/usr/bin/env python3
"""使用 libclang 提取 C/C++ 函数调用与源码上下文。"""

from __future__ import annotations

import argparse
from functools import cached_property
import json
import os
from pathlib import Path
import shlex
import sys
from typing import TypedDict, Optional

try:
    import clang.cindex as ci
except ImportError:
    ci = None

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
    needs_definition: bool


class CppCallExtractor:
    _libclang_initialized = False

    def __init__(self, libclang_path: 'Optional[str]' = None):
        self.libclang_path = libclang_path
        self._ensure_libclang_initialized()

    def _ensure_libclang_initialized(self):
        if ci is None:
            raise RuntimeError("C/C++ 分析需要 Python clang.cindex 和 libclang")
        if CppCallExtractor._libclang_initialized:
            return
        if self.libclang_path is None:
            configured = ci.Config().get_filename()
            if os.path.isabs(configured) and os.path.isfile(configured):
                self.libclang_path = configured
            else:
                try:
                    self.libclang_path = self._find_libclang()
                except FileNotFoundError:
                    # The binding may be able to load libclang from the system loader's search path.
                    pass
        if self.libclang_path is not None:
            self.libclang_path = os.path.abspath(self.libclang_path)
            if not os.path.isfile(self.libclang_path):
                raise FileNotFoundError(f"libclang not found at {self.libclang_path}")
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

    @cached_property
    def _clang_resource_dir(self) -> Optional[str]:
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
        libclang_path = ci.Config.library_file
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

    @staticmethod
    def _is_system_location(cursor) -> bool:
        # Older Python bindings do not expose SourceLocation.is_in_system_header.
        return bool(ci.conf.lib.clang_Location_isInSystemHeader(cursor.location))

    @staticmethod
    def _called_symbol(cursor):
        if cursor.kind != ci.CursorKind.CALL_EXPR:
            return None
        callee = cursor.referenced
        if callee and callee.spelling and callee.kind in (
            ci.CursorKind.FUNCTION_DECL, ci.CursorKind.CXX_METHOD, ci.CursorKind.FUNCTION_TEMPLATE,
            ci.CursorKind.DESTRUCTOR, ci.CursorKind.CONVERSION_FUNCTION, ci.CursorKind.VAR_DECL,
            ci.CursorKind.PARM_DECL,
        ):
            return callee
        return None

    @staticmethod
    def _split_command(command: str) -> list[str]:
        if sys.platform != 'win32':
            return shlex.split(command)

        # Windows command lines use backslashes literally except before double quotes.
        import ctypes
        from ctypes import wintypes

        split = ctypes.windll.shell32.CommandLineToArgvW
        split.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        split.restype = ctypes.POINTER(wintypes.LPWSTR)
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        argc = ctypes.c_int()
        argv = split(command.lstrip(), ctypes.byref(argc))
        if not argv:
            raise ctypes.WinError()
        try:
            return argv[:argc.value]
        finally:
            free(argv)

    @staticmethod
    def _path_key(path: str, directory: str = '') -> str:
        return os.path.normcase(os.path.realpath(os.path.join(directory, path)))

    @classmethod
    def _read_compile_commands(cls, path: str, filename: str | None = None) -> dict[str, tuple[str, dict]]:
        if not path:
            return {}
        database_dir = os.path.dirname(os.path.abspath(path))
        with open(path, encoding='utf-8-sig') as f:
            entries = json.load(f)
        file_key = cls._path_key(filename) if filename is not None else None
        commands = {}
        for entry in entries:
            directory = os.path.abspath(os.path.join(database_dir, entry['directory']))
            key = cls._path_key(entry['file'], directory)
            if file_key is not None and key != file_key:
                continue
            commands.setdefault(key, (directory, entry))
            if file_key is not None:
                break
        return commands

    def _parse_source(self, index, filename: str, commands: dict,
                      options: int = 0) -> tuple[ci.TranslationUnit, str]:
        entry_with_dir = commands.get(self._path_key(filename))
        parse_filename = filename
        original_dir = directory = os.getcwd()
        args = ['-ferror-limit=0']
        if entry_with_dir is None:
            args += ['-x', 'c', '-std=c17'] if filename.endswith('.c') else ['-x', 'c++', '-std=c++17']
        else:
            directory, entry = entry_with_dir
            command = entry['arguments'] if 'arguments' in entry else self._split_command(entry['command'])
            if not command:
                raise ValueError(f"Empty compile command for {filename}")
            driver = os.path.basename(command[0]).lower().removesuffix('.exe')
            if driver in ('cl', 'clang-cl'):
                args.append('--driver-mode=cl')
            elif driver.endswith('++'):
                args.append('--driver-mode=g++')

            # The database already provides the input file in argv; do not add it twice.
            parse_filename = None
            flags = iter(command[1:])
            for flag in flags:
                if flag in ('-o', '-include-pch'):
                    next(flags, None)
                elif flag == '--':
                    args.append(flag)
                    args.extend(flags)
                    break
                elif flag not in ('-c', '-Winvalid-pch') and not flag.startswith('-Wl,'):
                    args.append(flag)

        if not any(a == '-resource-dir' or a.startswith('-resource-dir=') for a in args):
            resource_dir = self._clang_resource_dir
            if resource_dir:
                args[0:0] = ['-resource-dir', resource_dir]

        # The compiler command can contain relative includes, forced headers and response files.
        if directory != original_dir:
            os.chdir(directory)
        try:
            return index.parse(parse_filename, args=args, options=options), directory
        finally:
            if directory != original_dir:
                os.chdir(original_dir)

    @staticmethod
    def _symbol(cursor) -> str | ci.Cursor:
        canonical = cursor.canonical
        return canonical.get_usr() or canonical

    @staticmethod
    def _parent_class(cursor):
        parent = cursor.semantic_parent
        while parent:
            if parent.kind in (ci.CursorKind.CLASS_DECL, ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_TEMPLATE):
                return parent.canonical
            parent = parent.semantic_parent
        return None

    @staticmethod
    def _qualified_name(cursor) -> str:
        parts = [cursor.spelling]
        parent = cursor.semantic_parent
        while parent and parent.kind != ci.CursorKind.TRANSLATION_UNIT:
            if parent.spelling:
                parts.append(parent.spelling)
            parent = parent.semantic_parent
        return '::'.join(reversed(parts))

    def _function_definitions(self, tu, filename: str, directory: str):
        file_key = self._path_key(filename)
        file_matches = {}
        function_kinds = (ci.CursorKind.CXX_METHOD, ci.CursorKind.FUNCTION_DECL,
                          ci.CursorKind.CONSTRUCTOR, ci.CursorKind.DESTRUCTOR,
                          ci.CursorKind.FUNCTION_TEMPLATE, ci.CursorKind.CONVERSION_FUNCTION)

        def walk(cursor):
            for node in cursor.get_children():
                file = node.location.file
                if file is not None:
                    path = file.name
                    if path not in file_matches:
                        file_matches[path] = self._path_key(path, directory) == file_key
                    if not file_matches[path]:
                        continue
                    if node.kind in function_kinds and node.is_definition():
                        yield node
                yield from walk(node)

        yield from walk(tu.cursor)

    def callees(self, filename: str, compile_commands_path: str = "",
                target_line: int = 0) -> tuple[list[CalleeInfo], str]:
        if target_line <= 0:
            raise ValueError("target_line must be specified")
        filename = os.path.abspath(filename)
        index = ci.Index.create()
        commands = self._read_compile_commands(compile_commands_path, filename)
        tu, directory = self._parse_source(index, filename, commands)
        target = next((node for node in self._function_definitions(tu, filename, directory)
                       if node.location.line == target_line), None)
        if target is None:
            raise ValueError(f"找不到函数定义: {filename}:{target_line}；请传入定义所在文件和行号")

        target_class = self._parent_class(target)
        file_key = self._path_key(filename)
        seen = set()
        callees = []
        for node in target.walk_preorder():
            callee = self._called_symbol(node)
            if callee is None or self._is_stdlib_name(callee.spelling) or self._is_system_location(callee):
                continue
            key = self._symbol(callee)
            if key in seen:
                continue
            seen.add(key)

            # A function pointer is an injection point, not an expandable function body.
            definition = (None if callee.kind in (ci.CursorKind.VAR_DECL, ci.CursorKind.PARM_DECL)
                          else callee.get_definition())
            definition_file = definition.location.file if definition is not None else None
            is_local = bool(definition_file and
                            self._path_key(definition_file.name, directory) == file_key)
            callee_class = self._parent_class(callee) if callee.kind == ci.CursorKind.CXX_METHOD else None
            is_same_class = target_class is not None and callee_class is not None and target_class == callee_class
            is_internal = is_local or is_same_class
            location = definition.location if is_internal and definition_file else callee.location
            path = os.path.abspath(os.path.join(directory, location.file.name)) if location.file else None
            callees.append(CalleeInfo(
                name=callee.spelling,
                class_name=callee_class.spelling if callee_class is not None else None,
                is_internal=is_internal,
                defined_in_file=path,
                defined_at_line=location.line if path else None,
                is_member=callee_class is not None,
                needs_definition=is_internal and not definition_file,
            ))
        return callees, target_class.spelling if target_class is not None else ""

    def write_context(self, input_path: str, output_dir: str, target_name: str, target_line: int | None,
                      compile_commands_path: str) -> None:
        index = ci.Index.create()
        input_path = Path(input_path).resolve(strict=True)
        is_directory = input_path.is_dir()
        commands = self._read_compile_commands(compile_commands_path, None if is_directory else str(input_path))
        no_match = f"找不到函数 {target_name} 的定义: {input_path}"
        ambiguous = f"函数 {target_name} 存在多个定义；请指定源文件、限定名或 --line"

        def matching_definitions(tu, filename, directory):
            for node in self._function_definitions(tu, filename, directory):
                if target_line is not None and node.location.line != target_line:
                    continue
                if target_name == node.spelling or ('::' in target_name and target_name == self._qualified_name(node)):
                    yield node

        def find_source():
            match = None
            for candidate in input_path.rglob('*'):
                if candidate.suffix not in ('.c', '.cc', '.cpp', '.cxx', '.C', '.h', '.hh', '.hpp', '.hxx'):
                    continue
                if not candidate.is_file():
                    continue
                filename = str(candidate)
                tu, directory = self._parse_source(index, filename, commands)
                if next(matching_definitions(tu, filename, directory), None) is not None:
                    if match is not None:
                        raise ValueError(ambiguous)
                    match = filename
            if match is None:
                raise ValueError(no_match)
            return match

        filename = find_source() if is_directory else str(input_path)
        tu, directory = self._parse_source(index, filename, commands,
                                           options=ci.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD)
        matches = matching_definitions(tu, filename, directory)
        target = next(matches, None)
        if target is None:
            raise ValueError(no_match)
        if next(matches, None) is not None:
            raise ValueError(ambiguous)
        errors = [str(diagnostic) for diagnostic in tu.diagnostics if diagnostic.severity >= ci.Diagnostic.Error]
        if errors:
            raise ValueError("Clang 无法解析目标文件:\n" + "\n".join(errors))

        functions = [target]
        seen_callees = {self._symbol(target)}
        globals_used = {}
        types_used = {}
        target_file = self._path_key(filename)
        target_class = self._parent_class(target)
        for function in functions:
            # Collect references for every emitted body, but expand calls only from the target.
            is_target = function is target
            for node in function.walk_preorder():
                if is_target:
                    callee = self._called_symbol(node)
                    if (callee is not None and callee.kind not in (ci.CursorKind.VAR_DECL, ci.CursorKind.PARM_DECL)
                            and callee.location.file and not self._is_system_location(callee)):
                        key = self._symbol(callee)
                        if key not in seen_callees:
                            seen_callees.add(key)
                            definition = callee.get_definition()
                            callee_class = (self._parent_class(callee)
                                            if callee.kind == ci.CursorKind.CXX_METHOD else None)
                            if definition is not None and (file := definition.location.file) and (
                                self._path_key(file.name, directory) == target_file
                                or (target_class is not None and target_class == callee_class)
                            ):
                                functions.append(definition)
                if node.kind not in (ci.CursorKind.DECL_REF_EXPR, ci.CursorKind.MEMBER_REF_EXPR,
                                     ci.CursorKind.TYPE_REF, ci.CursorKind.TEMPLATE_REF):
                    continue
                ref = node.referenced
                if ref is None or not ref.location.file or self._is_system_location(ref):
                    continue
                if ref.kind == ci.CursorKind.VAR_DECL:
                    parent = ref.semantic_parent
                    if parent is None or parent.kind not in (
                        ci.CursorKind.TRANSLATION_UNIT, ci.CursorKind.NAMESPACE, ci.CursorKind.LINKAGE_SPEC,
                        ci.CursorKind.CLASS_DECL, ci.CursorKind.STRUCT_DECL, ci.CursorKind.CLASS_TEMPLATE,
                    ):
                        continue
                    globals_used.setdefault(self._symbol(ref), ref.get_definition() or ref)
                elif node.kind in (ci.CursorKind.TYPE_REF, ci.CursorKind.TEMPLATE_REF):
                    if ref.kind == ci.CursorKind.TYPEDEF_DECL:
                        underlying = ref.underlying_typedef_type.get_canonical()
                        if underlying.kind == ci.TypeKind.RECORD:
                            record = underlying.get_declaration().get_definition()
                            if record is not None and record.location.file and not self._is_system_location(record):
                                start, alias_start = record.extent.start, ref.extent.start
                                if (start.file.name != alias_start.file.name
                                        or not alias_start.offset <= start.offset < ref.extent.end.offset):
                                    types_used.setdefault(self._symbol(record), record)
                    types_used.setdefault(self._symbol(ref), ref.get_definition() or ref)

        function_ranges = {}
        for function in functions:
            extent = function.extent
            path = self._path_key(extent.start.file.name, directory)
            function_ranges.setdefault(path, []).append((extent.start.offset, extent.end.offset))
        macros = {}
        for node in tu.cursor.get_children():
            if node.kind != ci.CursorKind.MACRO_INSTANTIATION or not node.location.file:
                continue
            loc = node.location
            ranges = function_ranges.get(self._path_key(loc.file.name, directory), ())
            if any(start <= loc.offset < end for start, end in ranges):
                macro = node.referenced
                if macro and macro.location.file and not self._is_system_location(macro):
                    macros.setdefault(self._symbol(macro), macro)

        files = {}

        def source_at(cursor, declaration=False):
            extent = cursor.extent
            path = os.path.join(directory, extent.start.file.name)
            if path not in files:
                files[path] = Path(path).read_bytes()
            source = files[path]
            snippet = source[extent.start.offset:extent.end.offset].decode('utf-8', errors='replace')
            if declaration:
                snippet = snippet.rstrip()
                if not snippet.endswith(';'):
                    snippet += ';'
            return snippet

        output = Path(output_dir)
        output.mkdir(parents=True, exist_ok=True)
        snippets = {
            'target_function_body.md': [source_at(target)],
            'callee_function_body.md': [source_at(function) for function in functions[1:]],
            'global_var_decl.md': [source_at(var, declaration=True) for var in globals_used.values()],
            'code_context.md': ([f'#define {source_at(macro)}' for macro in macros.values()]
                                + [source_at(decl, declaration=True) for decl in types_used.values()]),
            'io_paragraph.md': [
                '## 参数',
                *(f'- `{arg.spelling}`: `{arg.type.spelling}`' for arg in target.get_arguments()),
                '## 返回类型',
                f'`{target.result_type.spelling}`',
            ],
        }
        for name, lines in snippets.items():
            with (output / name).open('w', encoding='utf-8', newline='') as f:
                f.write('\n\n'.join(lines) + '\n' if lines else '')


def main() -> int:
    context = sys.argv[1:2] == ['--context']
    parser = argparse.ArgumentParser(description='提取 C/C++ 源码上下文' if context else '提取 C/C++ 函数调用')
    parser.add_argument('--libclang-path', '-L', help='libclang 库路径')
    parser.add_argument('--line', '-l', type=int, required=not context, help='函数定义所在行号')
    if context:
        parser.add_argument('--input', '-i', required=True, help='函数所在的源文件或最小目录')
        parser.add_argument('--output', '-o', required=True, help='输出目录')
        parser.add_argument('--target-function', '--targe-function', '-f', required=True, help='目标函数名')
        parser.add_argument('--compile-commands', '-p', default='', help='compile_commands.json 路径')
    else:
        parser.add_argument('source_file', help='源文件路径')
        parser.add_argument('--compile-commands', '-c', required=True, help='compile_commands.json 路径')
    args = parser.parse_args(sys.argv[2:] if context else None)
    try:
        extractor = CppCallExtractor(libclang_path=args.libclang_path)
        if context:
            extractor.write_context(args.input, args.output, args.target_function.strip(), args.line, args.compile_commands)
            return 0

        callees, _ = extractor.callees(args.source_file, args.compile_commands, args.line)
        if not callees:
            print("无函数调用")
        for item in callees:
            location = f"{item['defined_in_file']}:{item['defined_at_line']}"
            tag = "(内部依赖)" if item['is_internal'] else "(外部依赖)"
            extra = " [需查找实现位置]" if item['needs_definition'] else ""
            class_prefix = f"{item['class_name']}::" if item['class_name'] else ""
            print(f"{class_prefix}{item['name']} {location} {tag}{extra}")
    except Exception as error:
        print(f"错误: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
