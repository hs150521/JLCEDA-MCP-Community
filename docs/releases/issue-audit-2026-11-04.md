# 开放 Issue 核对记录（2026-11-04）

基线为社区仓库 `main` / `v2.4.0` 的 `c79e43d`。本轮核对全部五个开放 Issue，优先处理报告中的常见路径。用户授权的专用测试工程运行于 Windows 嘉立创EDA 4.1.78；不据此推断 Linux Electron 的行为。

| Issue | 当前结论 | 本轮证据 |
| --- | --- | --- |
| [#93 封装源完整性](https://github.com/hs150521/JLCEDA-MCP-Community/issues/93) | v2.4.0 已修复“完整空结果”的误报；原生源码缺失仍是能力限制 | 有器件 PCB 的原生源码列表为空，当前 handler 返回 `ok:false`、`complete:false`、`native_footprint_sources_empty_for_populated_pcb` 及 16 个封装引用；专项回归通过 |
| [#94 走线修改拆分](https://github.com/hs150521/JLCEDA-MCP-Community/issues/94) | v2.4.0 已按几何覆盖核对新交点、拆线及合并 | routing edit / split modify 两套回归通过；本轮未新增三线到七段的宿主写入测试 |
| [#95 覆铜重建](https://github.com/hs150521/JLCEDA-MCP-Community/issues/95) | v2.4.0 已包含部分原生返回集合与诊断修复；本轮重建结果未确认 | 专项回归通过。Gateway 发起一次重建后在 30 秒传输期限内未返回；随后完整回读为 17 个边框、17 个填充，边框相同、部分填充摘要改变。这不能证明原调用已结束或全部重建完成；未重试、未继续发送设计写入 |
| [#96 保留属性破坏绑定](https://github.com/hs150521/JLCEDA-MCP-Community/issues/96) | v2.4.0 已拒绝保留别名并检查三库绑定和 BOM 保留 | reserved / edit / issue 回归通过；本轮实机确认全部七个保留键在目标读取及原生修改前拒绝 |
| [#99 桌面创建挂起](https://github.com/hs150521/JLCEDA-MCP-Community/issues/99) | 主问题保留；本轮仅修复其中的 `lib_Device.get` 参数误用诊断 | 同一公共库器件实测：对象参数静默返回 `undefined`；正确位置参数、省略库参数和空字符串库参数均成功。新增回归确认错误参数零原生调用、合法参数和查询空结果保持原样 |

## 本轮代码修改

`eda.lib_Device.get` 的公开签名为 `get(deviceUuid: string, libraryUuid?: string)`。`api_invoke` 对此方法要求第一参为非空字符串，第二参为字符串或省略；错误提示直接给出正确的位置参数形式。不额外校验 UUID 格式，不修改宿主方法，也不把合法查询返回的 `undefined` 改写为错误。

新增用例接入已有 `schematic-native-compat-test.cjs`，由现有 `test:schematic-components` 和构建门禁执行。未改变工具 schema、路由、协议、超时或未知提交恢复策略。

连接代码本来就在每次 `ensureConnected` 创建 transport 时调用 `getConfiguredMcpUrl`。#99 提到的宿主配置内存缓存不能仅靠重复读取同一 getter 宣称解决，本轮不改该路径。

## 验证范围

本轮宿主验证通过已连接的 API Gateway 加载当前源码处理器，并调用公开 EDA API。没有建立 Community Bridge 客户端，因此这些记录不是 Community MCP 传输的端到端验证；传输与隔离路径由仓库自动回归覆盖。`api_invoke` 处理器依赖的离线文档资源不属于 API Gateway 安装包，新的参数校验由本地处理器回归验证，宿主测试用于确认原生参数语义。

覆铜超时后只进行完整回读、库查询和会在原生修改前被拒绝的参数预检。未自动重试重建或器件创建；后续设计写入前应结束原宿主调用并按正式 Bridge 的受控恢复流程核对目标。未保存、关闭或重启测试工程。

本地验证结果：Bridge 全部功能回归、typecheck、离线文档生成校验、API metadata、生产编译、runtime 校验和扩展打包通过；Bridge/Server lint 通过；Server 完整 `npm test` 和多客户端协议验证通过。

初次 Server 回归在并发构建期间触发既有 80 毫秒测试期限，完整复跑通过。Bridge 在功能回归及 typecheck 通过后，先因缺少 Windows `py` 启动器中断，使用工作区 Python 的 `PYTHON` 环境变量继续验证；Node 24 默认 TypeScript 加载又与项目的 ts-node 构建入口冲突，生产编译和打包通过 `node --no-experimental-strip-types node_modules/ts-node/dist/bin.js --project tsconfig.build.json` 分别运行原有入口完成。以上均未修改仓库的构建脚本；远端 Node 20 CI、审查及合并结果以 PR 为准。

本轮不据此关闭 #99，也不把超时后的可读填充当成 #95 原调用成功的证明；已发布修复的历史实机记录见 [v2.4.0](v2.4.0.md)。
