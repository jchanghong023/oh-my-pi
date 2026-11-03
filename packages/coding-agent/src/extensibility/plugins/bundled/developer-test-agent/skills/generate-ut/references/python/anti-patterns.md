# 反模式禁令

## Mock误用禁令（5条）
1. 禁止patch.object拦截self调用：`patch.object(ClassName, 'method')`会拦截被测函数内部的self.method()调用。用实例级赋值`obj.method = MagicMock()`替代
2. 禁止MagicMock(spec=)用于被测对象：用`ClassName.__new__(ClassName)` + 手动属性赋值
3. 禁止weakref.proxy + MagicMock(spec=)：proxy拦截属性访问与MagicMock自动属性冲突，用真实对象
4. 禁止同时设置side_effect和return_value：side_effect优先，return_value被静默忽略。合并为单个side_effect函数
5. 禁止patch框架类用于isinstance检查：patching Response/Request/Exception子类破坏isinstance。用真实对象

## 断言误用禁令（4条）
6. 禁止仅检查`is not None`：必须验证具体业务属性
7. 禁止复合`or`断言中一侧为mock调用检查：用独立断言
8. 禁止trivially-satisfied范围断言（`>= 0`、`!= None`）：当期望值已知时断言精确值
9. 禁止仅验证dict的key存在不验证value：`key in dict`通过但value可能为None或错误值

## 编码误用禁令（3条）
10. 禁止递归函数用assert_not_called：patching拦截递归调用。用call_count + 期望次数
11. 禁止bound method用`is`比较：bound method identity总是失败。用`__name__`比较或assert_called_once_with
12. 禁止Exception子类假设命名属性：简单Exception子类存储在`.args`tuple。先验证类定义了该属性

## 代码修改禁令（2条）
13. 禁止修改.coveragerc/setup.cfg/pyproject.toml等配置文件
14. 禁止读取项目自身test/目录文件（integration-style，浪费tokens），仅读取task tests/中的fixture
