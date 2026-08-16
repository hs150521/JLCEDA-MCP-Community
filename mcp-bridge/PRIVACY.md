# Privacy

JLCEDA MCP Community does not include analytics, advertising, crash reporting,
or project-data telemetry. The native server binds its Bridge listener to
`127.0.0.1`.

When an MCP client invokes a tool, the extension may read data from the active
JLCEDA project and return it through the local MCP connection. Your AI client
may then process or transmit that data according to the client's own settings,
provider terms, and privacy policy. Do not use the integration with confidential
designs unless that processing is acceptable to you.

The EDA extension stores its configured Bridge WebSocket URL locally. If the URL
contains a token, treat the setting and screenshots of it as credentials. Runtime
logs redact the token, but users should still review logs before sharing them.

The optional API passthrough tools can access the capabilities exposed by the
JLCEDA extension API. Enable them only for trusted MCP clients.

Privacy and security questions: `hs150521@proton.me`.
