# 2.3.0 架构

`contracts/bridge-contract.json` 是 MCP Server 和 EDA Bridge 之间的唯一契约来源。它定义公开 MCP 工具与 Bridge 路径、仅供交互式放置编排使用的内部路径、操作归属、超时策略，以及 WebSocket 消息的必填字段。

构建前 `tool/sync-bridge-contract.mjs` 会将该契约同步到两个包的运行时资源目录。Server 从同步后的契约注册分发路由并验证客户端消息；Bridge 从同一契约校验 Server 消息、解析超时和约束 handler 注册表。`mcp-server/scripts/verify-tool-routing.mjs` 与 `mcp-bridge/scripts/bridge-contract-test.cjs` 会拒绝不一致的资源、缺失的工具、未声明的内部路径或未注册的 Bridge handler。

```text
MCP client -> stdio Server -> EdaBridgeServer coordinator -> active EDA Bridge
                    |                  |                         |
                    |                  +-- bridge-wire            +-- handler registry
                    |                  +-- shared contract        +-- task timeout quarantine
                    |                                                    |
                    +-- component placement orchestration              EDA API
```

`EdaBridgeServer` 保持监听、主从接管、租约、请求生命周期和受控恢复协调；`bridge-wire` 只处理 WebSocket 编码、负载上限和 token 常量时间比较。Bridge 状态以 MessageBus 推送给设置页，扩展存储的去重快照只用于设置页首次打开时的回退显示。
