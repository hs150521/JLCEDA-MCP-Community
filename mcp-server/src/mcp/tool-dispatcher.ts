/**
 * ------------------------------------------------------------------------
 * 名称：MCP 工具分发器
 * 说明：将MCP工具调用通过WebSocket转发到EDA插件执行
 * ------------------------------------------------------------------------
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { EdaBridgeServer } from './bridge-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载工具定义
const toolDefinitionsPath = join(__dirname, '..', 'resources', 'mcp-tool-definitions.json');
const rawToolDefinitions = JSON.parse(readFileSync(toolDefinitionsPath, 'utf8'));

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 加载工具定义
function loadToolDefinitions(): readonly ToolDefinition[] {
  const parsed: unknown = rawToolDefinitions;
  if (!Array.isArray(parsed)) {
    throw new Error('工具定义文件格式非法：根节点必须是数组');
  }

  const definitions: ToolDefinition[] = [];
  for (const item of parsed) {
    if (!isPlainObjectRecord(item)) {
      throw new Error('工具定义项必须为对象');
    }

    const name = String(item.name ?? '').trim();
    const description = String(item.description ?? '').trim();
    if (name.length === 0 || description.length === 0) {
      throw new Error('工具定义项缺少 name 或 description');
    }
    if (!isPlainObjectRecord(item.inputSchema)) {
      throw new Error(`工具 ${name} 缺少 inputSchema 对象`);
    }

    definitions.push({
      name,
      description,
      inputSchema: item.inputSchema,
    });
  }
  return definitions;
}

const TOOL_DEFINITIONS = loadToolDefinitions();

export class ToolDispatcher {
  constructor(private readonly bridgeServer: EdaBridgeServer) {}

  /**
   * 返回工具定义列表
   */
  public getToolDefinitions(): readonly ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  /**
   * 分发工具调用到EDA插件
   */
  public async dispatch(toolCallParams: ToolCallParams): Promise<ToolCallResult> {
    const args = isPlainObjectRecord(toolCallParams.arguments) ? toolCallParams.arguments : {};
    
    try {
      if (toolCallParams.name === 'component_place') {
        return await this.dispatchInteractiveComponentPlace(args);
      }

      // 获取桥接路径
      const bridgePath = this.getBridgePath(toolCallParams.name);
      
      // 通过WebSocket发送到EDA插件执行
      const requestTimeoutMs = this.getRequestTimeoutMs(toolCallParams.name, args);
      const result = requestTimeoutMs === undefined
        ? await this.bridgeServer.request(bridgePath, args)
        : await this.bridgeServer.request(bridgePath, args, requestTimeoutMs + 2_000);
      
      // 包装为MCP响应格式
      return this.toToolContent(result);
    } catch (error) {
      throw new Error(`工具 ${toolCallParams.name} 执行失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getRequestTimeoutMs(toolName: string, args: Record<string, unknown>): number | undefined {
    if (!['api_invoke', 'eda_context', 'pcb_drc_check', 'schematic_drc_check', 'netlist_compare', 'manufacture_export', 'pcb_auto_layout', 'pcb_auto_routing'].includes(toolName)) {
      return undefined;
    }
    if (args.timeoutMs === undefined) {
      return undefined;
    }

    const timeoutMs = Number(args.timeoutMs);
    const extendedReadTool = ['pcb_drc_check', 'schematic_drc_check', 'netlist_compare', 'manufacture_export'].includes(toolName);
    const minimum = toolName.startsWith('pcb_auto_') ? 10_000 : extendedReadTool ? 5_000 : 1_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < minimum || timeoutMs > 120_000) {
      throw new RangeError(`timeoutMs must be an integer between ${String(minimum)} and 120000`);
    }
    return timeoutMs;
  }

  /**
   * 根据工具名获取桥接路径
   */
  private getBridgePath(toolName: string): string {
    const pathMap: Record<string, string> = {
      'schematic_read': '/bridge/jlceda/schematic/read',
      'schematic_review': '/bridge/jlceda/schematic/review',
      'component_select': '/bridge/jlceda/component/select',
      'component_place': '/bridge/jlceda/component/place',
      'component_place_auto': '/bridge/jlceda/component/place-auto',
      'netlabel_place': '/bridge/jlceda/netlabel/place',
      'netlabel_modify': '/bridge/jlceda/netlabel/modify',
      'pcb_drc_check': '/bridge/jlceda/pcb/drc-check',
      'schematic_drc_check': '/bridge/jlceda/schematic/drc-check',
      'pcb_constraints_query': '/bridge/jlceda/pcb/constraints-query',
      'netlist_compare': '/bridge/jlceda/netlist/compare',
      'project_info': '/bridge/jlceda/project/info',
      'manufacture_export': '/bridge/jlceda/manufacture/export',
      'pcb_auto_layout': '/bridge/jlceda/pcb/auto-layout',
      'pcb_auto_routing': '/bridge/jlceda/pcb/auto-routing',
      'pcb_net_query': '/bridge/jlceda/net/query-pcb',
      'schematic_net_query': '/bridge/jlceda/net/query-schematic',
      'schematic_auto_layout': '/bridge/jlceda/auto/layout',
      'schematic_auto_routing': '/bridge/jlceda/auto/routing',
      'api_index': '/bridge/jlceda/api/index',
      'api_search': '/bridge/jlceda/api/search',
      'api_invoke': '/bridge/jlceda/api/invoke',
      'eda_context': '/bridge/jlceda/context',
      'bridge_clients': '/bridge/admin/clients',
      'bridge_select_client': '/bridge/admin/select-client',
    };

    const path = pathMap[toolName];
    if (!path) {
      throw new Error(`未知工具: ${toolName}`);
    }

    return path;
  }

  /**
   * 包装为MCP tools/call响应格式
   */
  private toToolContent(result: unknown): ToolCallResult {
    const response: ToolCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
    if (isPlainObjectRecord(result)) {
      response.structuredContent = result;
    }
    return response;
  }

  private async dispatchInteractiveComponentPlace(args: Record<string, unknown>): Promise<ToolCallResult> {
    const descriptorResult = await this.bridgeServer.request('/bridge/jlceda/component/place', args);
    if (!isPlainObjectRecord(descriptorResult) || !isPlainObjectRecord(descriptorResult.placement)) {
      throw new Error('Bridge did not return a component placement descriptor');
    }

    const placement = descriptorResult.placement;
    const components = Array.isArray(placement.components) ? placement.components : [];
    if (components.length === 0) {
      throw new Error('Component placement descriptor contains no components');
    }

    const timeoutSeconds = Math.max(30, Math.min(180, Number(placement.timeoutSeconds) || 60));
    const retryCount = Math.max(0, Math.min(3, Number(placement.retryCount) || 0));
    const results: Array<Record<string, unknown>> = [];

    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const component = components[componentIndex];
      let placed = false;
      let userCancelled = false;
      let errorMessage = '';
      let attempts = 0;

      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        attempts = attempt + 1;
        let sessionId = '';
        try {
          const startResult = await this.bridgeServer.request('/bridge/jlceda/component/place/start', {
            component,
            timeoutSeconds,
          });
          if (!isPlainObjectRecord(startResult) || startResult.ok !== true) {
            throw new Error(String(isPlainObjectRecord(startResult) ? startResult.error ?? 'placement start failed' : 'placement start returned invalid data'));
          }

          sessionId = String(startResult.sessionId ?? '').trim();
          if (!sessionId) {
            throw new Error('placement start returned no sessionId');
          }

          const deadline = Date.now() + timeoutSeconds * 1000;
          while (Date.now() < deadline) {
            await delay(250);
            const checkResult = await this.bridgeServer.request('/bridge/jlceda/component/place/check', { sessionId }, 5000);
            if (!isPlainObjectRecord(checkResult) || checkResult.ok !== true) {
              throw new Error(String(isPlainObjectRecord(checkResult) ? checkResult.error ?? 'placement check failed' : 'placement check returned invalid data'));
            }
            if (checkResult.placed === true) {
              placed = true;
              break;
            }
            if (checkResult.userCancelled === true) {
              userCancelled = true;
              break;
            }
          }

          if (!placed && !userCancelled) {
            errorMessage = `Placement timed out after ${String(timeoutSeconds)} seconds`;
          }
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
          if (sessionId) {
            try {
              await this.bridgeServer.request('/bridge/jlceda/component/place/close', { sessionId }, 5000);
            } catch {
              // The check handler may already have cleaned up a completed session.
            }
          }
        }

        if (placed || userCancelled) {
          break;
        }
      }

      results.push({
        componentIndex,
        component,
        placed,
        userCancelled,
        attempts,
        ...(placed || userCancelled ? {} : { error: errorMessage || 'placement failed' }),
      });
    }

    const placedCount = results.filter((result) => result.placed === true).length;
    const cancelledCount = results.filter((result) => result.userCancelled === true).length;
    const failedCount = results.length - placedCount - cancelledCount;
    return this.toToolContent({
      ok: placedCount === results.length,
      placedCount,
      cancelledCount,
      failedCount,
      totalCount: results.length,
      results,
      message: `Interactive placement completed: ${String(placedCount)}/${String(results.length)} placed`,
    });
  }
}
