---
name: code-notes
description: Generate beginner-friendly Chinese explanation documents for Rust source files in this Tauri project, persisted under the gitignored `notes/` directory mirroring the source tree. Use whenever the user asks to explain, walk through, annotate, or understand any Rust file under `src-tauri/src/`. Triggers on phrases like "explain X.rs", "解释一下 db/manager.rs", "讲讲这个文件", "walk me through", "代码走读", "这个模块做什么", "help me understand this file", "注释一下".
---

# Code Notes

Generate a standalone Markdown explanation for **one** Rust source file and persist it under `notes/`. The audience is a Rust beginner learning this codebase — surface project-specific conventions and beginner pitfalls aggressively; assume general Rust syntax knowledge.

## Directory layout — mirror the source tree

Each source file maps to exactly one notes file. Strip the `src/` segment from the path, everything else is preserved:

| Source file | Notes file |
|---|---|
| `src-tauri/src/lib.rs` | `notes/src-tauri/lib.md` |
| `src-tauri/src/util.rs` | `notes/src-tauri/util.md` |
| `src-tauri/src/db/manager.rs` | `notes/src-tauri/db/manager.md` |
| `src-tauri/src/commands/world.rs` | `notes/src-tauri/commands/world.md` |
| `src-tauri/src/models/character.rs` | `notes/src-tauri/models/character.md` |

Rules:
- **One `.md` per `.rs` file.** Never merge multiple source files into one note, even if they form a module.
- **Re-explaining a documented file → overwrite the entire `.md`.** Never append dated sections; that produces drift and contradicts itself over time.
- `notes/` is gitignored — these are personal learning notes, not shipped documentation.

## File template

Use this structure. Skip a section only when it genuinely does not apply (e.g. a trivial util may omit "依赖关系").

````markdown
# {path/to/file}.rs

> 源文件: `src-tauri/src/{path}.rs`

## 一句话职责

{这个文件做什么,1–2 句}

## 核心概念

{为什么这样设计?关键决策背后的理由。指向 AGENTS.md 里对应章节,不要抄写原文。}

## 逐段解读

### `{SymbolName}` — {struct / fn / trait / macro / const}
{职责 + 关键字段或参数 + 行为。重复此层级,覆盖文件内每个顶层符号。}

## 依赖关系

- **被谁调用**: ...
- **调用了什么**: ...
- **Tauri 注册点**: (仅 command 文件) 在 `lib.rs` 的 `invoke_handler!` 里以何名称注册

## 对新手容易困惑的点

- {项目特有约定,优先列出 — 见下方"项目特定陷阱"清单}
- {Rust 语言层面的坑,仅当真的出现在本文件中才写}
````

## 写作原则

**写给 Rust 新手,用中文**:
- 解释**为什么**这么写,不是**什么**语法。`fn`、`struct`、`impl`、`pub` 这些不用展开。
- 项目特有约定 >>> Rust 通用知识。前者对新读者是新信息,后者不是。
- 给具体符号名或行号锚点,让读者能立刻在源码里定位。
- 代码块、符号名、类型名、crate 名保留英文原文。

**避免**:
- 逐行翻译代码为中文。读者能读源码,他们要的是上下文。
- 罗列每个 `use` 的作用。只在 import 不直观时(宏导入、重命名导入、模糊路径)说明。
- 复制 AGENTS.md 的原文。指向它,而非抄写它。

## 项目特定陷阱 — 务必在相关文件中高亮

这些是本项目中**最容易让 Rust 新手卡住**的项目级约定。若某文件涉及下列任一项,在"对新手容易困惑的点"里展开解释,不要只写"参见 AGENTS.md":

| 陷阱 | 出现位置 | 为什么会困惑 |
|---|---|---|
| `#[serde(rename_all = "camelCase")]` | 所有 `models/*.rs` | Rust 字段是 snake_case,序列化到前端变成 camelCase。新手会奇怪"字段叫 `world_id`,JSON 里怎么是 `worldId`" |
| `Vec<String>` 存为 JSON TEXT | `models/*.rs` (`tags`、`aliases` 等字段) | SQLite 没有数组类型,这里用 `serde_json` 序列化为字符串。新手会找"数组列"找不到 |
| UUID v7(不是自增 ID) | `util.rs::new_id()`、所有模型主键 | 时间排序但不连续,新手会困惑为什么 ID 不是 1/2/3 |
| DbManager 锁顺序 | `db/manager.rs` | 必须先释放 `meta` 锁,再获取 `worlds` 锁;反过来会死锁。新手看不出顺序为什么重要 |
| `world_id` 不是列 | 所有 world-scoped 表 | "每个 world 就是一个 .db 文件"这一架构决策。新手会期待表里有 `world_id` 字段 |
| `load_element!` 宏 | `commands/element.rs` | Location/Item/Lore 共享同一 schema,新手会奇怪为什么三个实体看起来一模一样 |
| Junction refs 全删再插 | `commands/event.rs`、`commands/novel.rs` | 更新关联不是 PATCH,而是事务里 delete-all + re-insert |
| `foreign_keys = ON` + `journal_mode = WAL` | `db/manager.rs` 连接初始化 | 每个 connection 都要显式开启,新手会以为这是全局配置 |

## 工作流

1. **读源文件** — 用 `read` 完整读取目标 `.rs`。
2. **查 AGENTS.md** — 确认涉及的模块在 AGENTS.md 里有没有专门描述的约定。
3. **追依赖** — 必要时读它 import 的本地模块(如 `crate::db::manager`),确认实际行为。
4. **算输出路径** — 剥掉 `src/` 段,拼到 `notes/` 下。
5. **写文件** — 用 `write` 覆盖式写入。若已存在,整体替换。
6. **回报用户** — 一句话总结 + 写入的绝对路径。

## 禁止

- **不要** 把多个源文件合并到一个 notes — 严格 1:1。
- **不要** 追加到已存在 notes 的末尾 — 整体重写。
- **不要** 为前端 (`src/*.ts(x)`) 文件生成 notes — 此 skill 限定 Rust(用户的学习目标是 Rust)。
- **不要** 创建 README、INDEX、CHANGELOG、目录树等辅助文件 — 每个笔记独立、扁平、按路径寻址即可。
