"""配置里「列表型」取值的统一解包。

存储契约是 list[str]，但实际有三种写法会流进来：
  1) 旧前端 / 直接调 API 提交的逗号串（后端写入校验会归一，但历史数据未必）；
  2) 手工编辑 system_config.json 时写成字符串；
  3) 早期版本的默认值格式。

各读取点此前的容错程度并不一致 —— 有的会主动拆分（homework / security_guard /
wrong_book），有的直接 set(str)（会把 "exam,system" 碎成字符集，通知静默全丢），
还有的直接字符串拼接（扩展名白名单会拼成字符集，上传全拒）。

统一收口到这里：无论存的是列表还是字符串，都返回一个干净的 list[str]。
"""
import re
from typing import Any

# 与 config_router._validate_config_updates 的分隔符口径保持一致（中/英逗号、顿号、分号、换行）；
# 故意不按空格拆 —— 学科名可能含空格（如「AI 基础」）
_SPLIT_RE = re.compile(r"[,，、;；\n]+")


def as_str_list(value: Any, default: list[str] | None = None) -> list[str]:
    """把配置值解包成 list[str]；无法解包或解出空列表时回落到 default。"""
    if value is None:
        return list(default or [])
    if isinstance(value, str):
        parts = _SPLIT_RE.split(value)
    elif isinstance(value, (list, tuple, set)):
        parts = [str(x) for x in value]
    else:
        return list(default or [])
    out = [x.strip() for x in parts if x and x.strip()]
    return out or list(default or [])
