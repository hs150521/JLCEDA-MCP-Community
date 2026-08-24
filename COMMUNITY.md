# 社区项目说明

JLCEDA MCP Community 是由社区维护的 sengbin/JLCEDA-MCP 分支。

- 仓库：https://github.com/hs150521/JLCEDA-MCP-Community
- 联系邮箱：hs150521@proton.me
- 许可证：Apache License 2.0
- 项目状态：独立社区项目，与嘉立创 EDA 及上游维护者没有隶属或背书关系

## 署名

原始作品和贡献历史依据 Apache-2.0 许可证保留。社区新增内容通过 Git 历史和发布说明记录。产品和公司名称仅用于说明兼容性。

## 分支策略

- main：稳定的社区兼容分支。
- audit/native-mcp-v2：保留 PR #6 原型和社区审计记录。
- native-mcp-v2：在自动化测试和安全控制下重建的原生 MCP 实现。

PR #6 审计记录见 docs/audits/PR-6-native-mcp.md。

## 发布要求

发布社区 EDA 扩展前，必须具备：

1. 新的扩展 UUID 和唯一包名；
2. 原创且不侵权的图标；
3. 明确的社区发布者和仓库元数据；
4. 可复现的 MCP Server 与 EDA 扩展构建；
5. 自动化协议、路由和生命周期测试；
6. 成功的打包产物冒烟测试；
7. 针对受支持编辑器版本的 EDA 集成测试；
8. 保留 Apache-2.0 许可证及适用的署名声明。

涉及安全的问题应在公开披露前发送至 hs150521@proton.me。
