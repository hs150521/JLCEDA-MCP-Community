# PR #6 原生 MCP 架构历史审计

审计日期：2026-08-16
审计基线：`090d441`（`sengbin/JLCEDA-MCP#6`）
社区联系：`hs150521@proton.me`

> 本文是 2026-08-16 的历史记录，描述当时上游 PR #6 和社区 `native-mcp-v2` 分支的状态，不代表当前 `v2.2.0` 发布结论。

## 当时结论

该架构方向可行，但当时的上游分支尚不能合并到发布分支或上传嘉立创扩展广场。应将其视为原型，并在自动化测试保护下选择性重建。

## 社区整改状态

以下能力已在当时社区提交 `efc54e7` 的 `native-mcp-v2` 分支落实：

- 构建产物会复制必需运行时资源，并由冒烟测试执行；
- STDIO EOF 会关闭进程并释放 Bridge 监听器；
- WebSocket 仅监听 `127.0.0.1`，且校验精确路径；
- 可选共享 token 认证覆盖 EDA 与内部 MCP 路由，并对日志脱敏；
- 已实现 EDA `hello`/`welcome`、心跳过期、就绪状态、活动/备用租约、结果校验与接管；
- 请求 ID 包含进程 UUID，多 MCP 路由有集成测试；
- EDA 客户端上报官方工程、文档、页面身份，MCP 工具可列出并精确选择目标客户端；
- 社区 Bridge 2.0.1 已在嘉立创 EDA 专业版 3.2.181 中完成只读集成测试；
- 原始监听器退出后，存活的 MCP 进程可竞争接管；
- 手写 MCP 实现已替换为官方 TypeScript Server SDK 2.0；
- 测试覆盖旧版初始化、2026-07-28 `server/discover`、`tools/list`、Bridge 路由、路径/认证拒绝和 EDA 接管；
- Linux、Windows 和扩展打包 GitHub Actions 任务通过；
- 已删除临时包、重复服务端 API 数据、备用传输实现和不可达处理器；
- 社区扩展使用独立 UUID、名称、发布者、仓库元数据和原创图标。

当时仍建议继续加强 TypeScript 严格性、建立仓库级 lint 基线，并逐项审查原始或可写 EDA 工具的用户可见安全边界。原审计建议将共享 token 设为强制或提供安全的首次启动交换；该建议未被采纳，当前社区版的既定策略是仅监听 localhost，`JLCEDA_BRIDGE_TOKEN` 保持可选。

## 当时验证结果

- `mcp-server` 的 `npm ci`、`npm run build` 通过；
- `mcp-bridge` 的 `npm ci`、`npm run build` 通过并生成 EEXT；
- 针对 `registry.npmjs.org` 的生产依赖审计在两个包中均未发现已知漏洞；
- 当时 `mcp-server` 尚无可运行的 ESLint 配置；
- 当时 Bridge 源码 lint 报告 222 个错误，完整 lint 还会受生成 JSON 缩进影响；
- 当时编译后的 MCP Server 因未复制运行时资源而无法在初始化前启动。

## 当时的发布阻断项

### 严重：编译后的 MCP Server 无法运行

当时 `npm run build` 只执行 `tsc`。运行时代码从 `dist` 的相对路径读取资源，但构建没有复制它们，先后缺少：

- `dist/resources/agent-instructions.md`
- `dist/resources/mcp-tool-definitions.json`

因此构建曾出现假阳性。当前构建已通过 `scripts/copy-resources.mjs` 复制这些资源，并由冒烟测试验证。

### 严重：未认证 WebSocket 可能监听到 localhost 之外

当时 `EdaBridgeServer.startAsMainServer()` 仅使用端口创建 WebSocketServer，未显式指定主机，也没有校验路径、来源、token、角色或协议握手。Bridge 暴露原始 EDA API 调用，意外连接可能修改已打开的工程。

当前实现显式绑定 `127.0.0.1`、校验精确端点，并允许用户按本机环境选择是否设置共享 token。

### 高：没有确定的 EDA 页面选择

当时所有 EDA 套接字存放在一个 `Set` 中，请求发送给第一个套接字，缺少客户端身份、工程/页面上下文、就绪状态、活动/备用租约和显式页面选择。多个 EDA 标签页打开时，任务可能执行到错误工程或页面。

该项已在社区 `native-mcp-v2` 分支解决：Bridge 在 `hello`/心跳消息中上报官方工程、文档和页面身份；`bridge_clients` 列出就绪客户端，`bridge_select_client` 按准确客户端 ID 变更活动租约，并拒绝缺失、未就绪或存在活动任务的切换。

### 高：多进程路由缺少会话安全

当时附加 MCP 进程连接 `/mcp-internal` 时未认证，请求 ID 独立生成且未命名空间化，主进程用一个映射保存全部请求，碰撞可能误路由或丢失响应；原主进程退出后也没有稳健的晋升路径。

### 高：生命周期与重连不完整

- STDIO EOF 不会关闭 MCP 进程，遗留进程可能继续占用固定端口；
- EDA 传输定义了断开/错误处理器，却未在当时分支实际使用的传输上注册关闭回调；
- 缺少心跳和陈旧连接检测；
- Server 地址被硬编码，尽管界面提供连接设置。

### 高：发布元数据冒充上游或官方身份

当时扩展沿用了上游 UUID、名称、图标、发布者和链接，MCP 包作者仍为 `JLCEDA`。社区发布必须使用独立 UUID、包名、原创图标、社区发布者身份、正确仓库链接和明确的非官方声明。

## 当时的质量与可维护性发现

- MCP Server 未启用 TypeScript 严格模式；
- 缺少自动化测试套件与 CI 质量门禁；
- MCP Server 声明了 lint 命令但没有 lint 配置；
- Bridge 源码存在大量 lint 错误；
- 备用实现和多套客户端/服务端传输并存，运行路径难以确定；
- 生成 API 文档在多个位置重复；
- `build/temp_check` 与 `build` 下提交了临时包、编译 JavaScript、ZIP、大型 GIF 和大量一次性调试记录；
- 同一个 PR 混合了架构替换、新工具、生成数据、文档、打包和行为变更。

## 当时的 MCP 协议发现

当时 Server 仅实现少量手写 MCP 子集，固定返回协议版本 `2024-11-05`，未跟踪初始化状态或协商客户端请求的版本。建议使用官方 TypeScript SDK，或至少补充初始化、通知、取消、错误与关闭的一致性测试。

参考：

- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://modelcontextprotocol.io/specification/draft/basic/transports

## 当时建议的社区迁移计划

1. 在原生 Server 重建期间保留上游 1.5.x 架构作为稳定兼容分支；
2. 新建只含 `mcp-server`、`mcp-bridge`、必要文档和可复现打包输入的 `native-mcp-v2` 分支；
3. 以仅限 localhost 的 Broker 替换 WebSocket 层，并加入 EDA 页面身份和活动客户端选择；
4. 使用官方 MCP SDK，补充协议与生命周期测试；
5. 为路由、请求超时、断线接管和请求 ID 隔离添加单元测试，并加入启动编译后 Server 的集成冒烟测试；
6. 构建时复制资源，并在构建后实际执行打包产物验证；
7. 在 API 和安全审查后逐项重新引入 PR #6 工具；
8. 重塑为 **JLCEDA MCP Community**，保留 Apache-2.0 署名，并在发布前满足扩展广场要求。

扩展广场参考：<https://prodocs.easyeda.com/cn/api/guide/extensions-marketplace.html>
