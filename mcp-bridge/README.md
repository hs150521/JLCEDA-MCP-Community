# MCP Bridge 社区版

让支持 MCP 的 AI 客户端连接嘉立创 EDA，协助读取和编辑原理图、PCB 与封装，搜索器件、检查设计并导出数据。本扩展为社区项目。

## 安装与连接

需要嘉立创 EDA 专业版 3.x、Node.js 20 或更高版本，以及支持 MCP 的 AI 客户端。

1. 从 [发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases/tag/v2.3.10) 下载同版本的扩展 `.eext` 和 Server `.tgz`。
2. 在 EDA 的「高级 → 扩展管理器 → 导入」安装扩展，启用「外部交互」权限，重启 EDA 并打开原理图、PCB 或独立封装文档。
3. 在下载目录执行以下命令安装 Server：

```powershell
npm install --global .\jlceda-mcp-server-2.3.10.tgz
```

4. 在 AI 客户端添加本地 MCP 服务，启动命令填 `jlceda-mcp`，传输方式选 STDIO。客户端启动服务后，在 EDA 的「MCP Bridge 社区版 → 连接设置」确认状态为已连接，默认地址为 `ws://127.0.0.1:8765/bridge/ws`。

## 使用说明

连接后可直接向 AI 描述任务。修改前请保存工程，并确认操作的项目和页面；交互放置时按 Esc 或右键结束当前器件放置。无法连接时，检查 Server 是否启动及扩展的「外部交互」权限。

详细配置和使用说明见 [安装指南](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)，问题反馈见 [社区仓库](https://github.com/hs150521/JLCEDA-MCP-Community/issues)。

[Apache License 2.0](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-bridge/LICENSE) · [隐私说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-bridge/PRIVACY.md)
