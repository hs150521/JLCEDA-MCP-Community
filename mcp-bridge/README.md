# MCP Bridge 社区版

让支持 MCP 的 AI 客户端连接嘉立创 EDA，协助读取和编辑原理图、PCB 与封装，搜索器件、检查设计并导出数据。本扩展为社区项目。

## 安装与连接

当前源码支持嘉立创 EDA 专业版 3.x 与 4.x，扩展 engines 为 `^3.0.0 || ^4.0.0`；需要 Node.js 20 或更高版本，以及支持 MCP 的 AI 客户端。以下 2.4.0 安装示例包含本轮 EDA v4 适配，请保持 Bridge 与 Server 版本一致；可下载状态以发布页为准。

1. 从 [发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 下载同版本的扩展 `.eext` 和 Server `.tgz`。
2. 在 EDA 的「高级 → 扩展管理器 → 导入」安装扩展，启用「外部交互」权限，重启 EDA 并打开原理图、PCB 或独立封装文档。
3. 在下载目录执行以下命令安装 Server：

```powershell
npm install --global .\jlceda-mcp-server-2.4.0.tgz
```

4. 在 AI 客户端添加本地 MCP 服务，启动命令填 `jlceda-mcp`，传输方式选 STDIO。客户端启动服务后，在 EDA 的「MCP Bridge 社区版 → 连接设置」确认状态为已连接，默认地址为 `ws://127.0.0.1:8765/bridge/ws`。

## 2.4.0：EDA v4 适配

官方类型和离线 API 索引同步到 `@jlceda/pro-api-types 0.4.27`。`api_search` 暴露备注、弃用信息及 `minimumEditorVersions`；`api_invoke` 根据能够读取的宿主版本和索引元数据拦截明确不支持的调用，返回 `EDA_VERSION_UNSUPPORTED`、`commitStatus:"not_started"` 和 `nativeCallAttempted:false`。类型包中标记从 4.1.79、4.2 或 v5 新增的接口，不会因扩展已支持 EDA v4 就自动放行给更旧宿主。未知版本或缺少元数据时仍需检查原生能力和返回值。

- 原理图 PNG/SVG：`manufacture_export` 使用 `domain:"schematic"`、`kind:"png"` 或 `"svg"`。PNG 的可选 `resolution` 至少包含 width/height 中一项，每边须为 1–4096 的整数；省略时使用原生分辨率。SVG 不接受 resolution，多图页可能返回 ZIP。旧 `kind:"document"` 保留，其原生方法从 EDA v4.1 起弃用。
- 原理图归档：`design_archive_export action:"schematic"` 导出当前原理图，沿用文件名、归档类型和受限 Base64 返回。PNG/SVG 和此归档分支要求 EDA 3.2.183 / 4.1.23 或对应主版本的更新版本。
- 设计比较：原理图/PCB 比较要求 EDA 3.2.205 / 4.1.62。原理图仅接受 UUID 字符串；PCB 可选 `options.valUnit`（mil/mm/inch/cm）、有限正数 `deviation` 和 `comparisonSize`，按原生 `success` 判断结果。
- 库分类：优先使用 `getClassificationTree`；新方法缺失，或新版合法空树而旧树非空时，使用旧接口。新版抛错/非法结果不回退，旧接口缺失或两边均空时保留新版空树；`classificationApi` 和发生回退时的 `fallbackReason` 标明来源。每个节点返回完整 `namePath`，原生提供 UUID 时保留。

PR #97 复查补充了幂等直线修改与已有铜线合并核验、封装引用盘点不可用时的 `complete:false`、以及原理图器件三种库绑定和未请求 BOM 属性的写后检查。自定义属性更新不得静默清空供应商、制造商等字段；旧宿主缺少绑定 getter 时明确报告不可核验项。

匹配 Bridge/Server 2.4.0 已在 EDA 4.1.78 的专用测试项目副本实测通过器件修改/恢复、BOM/三库绑定保留、线宽操作和新导出；最后代码的公共库分类回退及 17 个填充的覆铜重建复测通过，不再误隔离。两端完整本地门禁及末轮定向验证通过；EDA 3.x 本轮未重跑，未逐项实测全部 API。此处记录本地验证；远端检查与下载状态以 GitHub Actions/Release 为准，详见 [2.4.0 验证与依赖审计范围](https://github.com/hs150521/JLCEDA-MCP-Community/blob/v2.4.0/docs/releases/v2.4.0.md)。

## 使用说明

连接后可直接向 AI 描述任务。修改前请保存工程，并确认操作的项目和页面；交互放置时按 Esc 或右键结束当前器件放置。无法连接时，检查 Server 是否启动及扩展的「外部交互」权限。

详细配置和使用说明见 [安装指南](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)，问题反馈见 [社区仓库](https://github.com/hs150521/JLCEDA-MCP-Community/issues)。

[Apache License 2.0](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-bridge/LICENSE) · [隐私说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-bridge/PRIVACY.md)
