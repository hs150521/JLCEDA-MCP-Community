# 安全政策

JLCEDA MCP Community 通过本地 WebSocket Bridge 控制 EDA 应用。部分公开操作可以修改原理图、PCB 文档、库和工程数据，因此应将 Bridge 访问视为等同于直接操作当前 EDA 会话。

## 支持范围

安全修复会先在 native-mcp-v2 上开发，待该架构提升为稳定分支后再合并。已发布版本和当前稳定分支享有优先支持。

## 漏洞报告

请将安全问题私下发送至 hs150521@proton.me，并附上受影响的提交或版本、复现步骤、影响范围和建议的缓解措施。修复可用前请不要公开可运行的漏洞利用代码。

## 本地 Bridge 保护

- 原生 Bridge 只监听 127.0.0.1。
- 设置 JLCEDA_BRIDGE_TOKEN，即可在 /bridge/ws 和 /mcp-internal 上要求共享密钥。
- EDA 扩展会在配置的 WebSocket 地址中使用 ?token=... 连接。
- Bridge 日志会隐藏 token、access_token 和 auth 查询参数。
- 不要通过防火墙规则、反向代理、隧道或端口转发暴露 8765 端口。

不设置 JLCEDA_BRIDGE_TOKEN 可暂时兼容本地环境，但同一用户下运行的任意进程都可能尝试连接 Bridge。

