# 嘉立创 EDA 实机集成测试：社区 Bridge 2.0.1

测试日期：2026-08-16

## 环境

- Windows 上的嘉立创 EDA 专业版 3.2.181
- JLCEDA MCP Community Bridge 2.0.1
- 原生 MCP Server 2.1.0
- 工程 `2026`，原理图页 `POWER DISTRIBUTION`

## 发现与修复

首次安装 2.0.0 时，TCP/WebSocket 连接已建立，但 EDA 进程始终没有注册就绪客户端。原因是打包后的扩展入口仍导入废弃的客户端模式运行时，原生的 `hello`、`ready` 与心跳实现没有实际运行。

2.0.1 将真实扩展入口切换到 `bridge-runtime.ts`，恢复设置页 iframe，补齐停止/重启生命周期导出，并加入构建期包内容断言。缺少所需原生协议标识或仍包含废弃入口时，构建会失败。

## 只读验证

以下检查均在已安装的桌面应用中通过：

- `bridge_clients` 返回一个就绪且活动的 2.0.1 客户端；
- Bridge 身份返回工程 `2026`、文档类型 `1` 与页面 `POWER DISTRIBUTION`；
- `eda_context` 返回相同的工程、文档和页面身份，并列出全部七张原理图页；
- `schematic_review` 返回 3,717 字符的全工程网表；
- `api_search` 找到 `eda.dmt_Schematic.getCurrentSchematicPageInfo` 的官方精确签名；
- `api_invoke` 以空参数调用该只读 API，并返回相同的当前页面身份；
- GitHub CI 在 Ubuntu、Windows 与 EEXT 打包任务上均通过。

既有工程返回 `drcCheckPassed: false`。该结果仅记录为工程当前状态，未忽略警告，也没有执行自动修改。

## 未覆盖范围

- 未调用任何会修改 EDA 文档的 API；
- 自动化 Bridge 测试覆盖了多页面选择，但本次桌面实测仅连接一个 EDA 页面；
- 此兼容性测试未启用共享 token 认证。
