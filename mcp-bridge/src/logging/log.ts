/**
 * ------------------------------------------------------------------------
 * 名称：Bridge 日志主管道
 * 说明：统一管理 Bridge 日志结构、字段模型、缓存与监听分发。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-20
 * 备注：不包含桥接发送策略，发送策略由运行时派发管道处理。
 * ------------------------------------------------------------------------
 */

import { BRIDGE_BUILD_DATE, BRIDGE_BUILD_WATERMARK, BRIDGE_VERSION } from '../build-info.ts';

/**
 * 统一日志级别。
 */
export type UnifiedLogLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * 统一日志字段定义。
 */
export interface UnifiedLogFieldSchema {
	fieldOrder: string[];
	fieldLabels: Record<string, string>;
	defaultVisibleFields: string[];
}

/**
 * 统一日志记录结构。
 */
export interface UnifiedLogEntry {
	id: string;
	timestamp: string;
	level: UnifiedLogLevel;
	fields: Record<string, string>;
}

export const BRIDGE_DIAGNOSTIC_LOG_STORAGE_KEY = 'mcp_bridge_diagnostic_logs';

export interface BridgeLogBuildInput {
	level: UnifiedLogLevel;
	module: string;
	event: string;
	summary: string;
	message: string;
	toolName?: string;
	bridgePath?: string;
	edaApi?: string;
	requestId?: string;
	phase?: string;
	runtimeStatus?: string;
	bridgeStatus?: string;
	bridgeWebSocketUrl?: string;
	host?: string;
	port?: string;
	contextKey?: string;
	clientId?: string;
	activeClientId?: string;
	leaseTerm?: string;
	bridgeClientCount?: string;
	detail?: string;
	errorCode?: string;
	errorName?: string;
	errorStack?: string;
}

type BridgeLogListener = (logEntry: UnifiedLogEntry) => void;

const LOG_FIELD_ORDER = [
	'timestamp',
	'level',
	'source',
	'version',
	'buildDate',
	'buildWatermark',
	'module',
	'event',
	'summary',
	'message',
	'toolName',
	'bridgePath',
	'edaApi',
	'requestId',
	'phase',
	'runtimeStatus',
	'bridgeStatus',
	'bridgeWebSocketUrl',
	'host',
	'port',
	'contextKey',
	'clientId',
	'activeClientId',
	'leaseTerm',
	'bridgeClientCount',
	'detail',
	'errorCode',
	'errorName',
	'errorStack',
] as const;

const LOG_FIELD_LABELS: Record<string, string> = {
	timestamp: '时间',
	level: '级别',
	source: '来源',
	version: '版本',
	buildDate: '构建日期',
	buildWatermark: '版本日期水印',
	module: '模块',
	event: '事件',
	summary: '摘要',
	message: '消息',
	toolName: '工具',
	bridgePath: 'Bridge 路由',
	edaApi: 'EDA 函数',
	requestId: '请求 ID',
	phase: '执行阶段',
	runtimeStatus: '运行时状态',
	bridgeStatus: '桥接状态',
	bridgeWebSocketUrl: '桥接地址',
	host: '监听地址',
	port: '监听端口',
	contextKey: '上下文键',
	clientId: '客户端ID',
	activeClientId: '活动客户端ID',
	leaseTerm: '租约',
	bridgeClientCount: '客户端数量',
	detail: '详情',
	errorCode: '错误码',
	errorName: '异常类型',
	errorStack: '异常堆栈',
};

const BRIDGE_LOG_LIMIT = 200;
const EDA_LOG_REPORT_LIMIT = 100;
const EDA_LOG_REPORT_TEXT_LIMIT = 240;
const EDA_DEFAULT_VISIBLE_FIELDS = [
	'timestamp',
	'level',
	'buildWatermark',
	'summary',
	'toolName',
	'bridgePath',
	'edaApi',
	'requestId',
	'phase',
	'message',
	'errorCode',
] as const;

interface StoredBridgeDiagnosticLogs {
	schemaVersion: 1;
	updatedAt: string;
	logs: UnifiedLogEntry[];
}

// 统一规范文本输入，避免空值与两端空白影响日志结果。
function normalizeText(value: unknown): string {
	return String(value ?? '').trim();
}

function redactBridgeWebSocketUrl(value: string | undefined): string | undefined {
	if (!value) {
		return value;
	}
	try {
		const parsed = new URL(value);
		for (const key of ['token', 'access_token', 'auth']) {
			if (parsed.searchParams.has(key)) {
				parsed.searchParams.set(key, '[REDACTED]');
			}
		}
		if (parsed.password) {
			parsed.password = '[REDACTED]';
		}
		return parsed.toString();
	}
	catch {
		return value.replace(/([?&](?:token|access_token|auth)=)[^&#]*/gi, '$1[REDACTED]');
	}
}

// 生成北京时间 HH:mm:ss 展示文本。
function formatBeijingTimeOnly(date: Date): string {
	try {
		return new Intl.DateTimeFormat('zh-CN', {
			timeZone: 'Asia/Shanghai',
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).format(date);
	}
	catch {
		const utcMillis = date.getTime();
		const beijingDate = new Date(utcMillis + (8 * 60 * 60 * 1000));
		const hh = String(beijingDate.getUTCHours()).padStart(2, '0');
		const mm = String(beijingDate.getUTCMinutes()).padStart(2, '0');
		const ss = String(beijingDate.getUTCSeconds()).padStart(2, '0');
		return `${hh}:${mm}:${ss}`;
	}
}

// 生成日志唯一 ID。
function createLogId(timestamp: string, event: string, module: string): string {
	return `${Date.parse(timestamp) || Date.now()}_${module}_${event}`;
}

// 清理字段空值，仅保留非空字段。
function compactFields(fields: Record<string, string | undefined>): Record<string, string> {
	const compacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(fields)) {
		const normalizedValue = normalizeText(value);
		if (normalizedValue.length === 0) {
			continue;
		}
		compacted[key] = normalizedValue;
	}
	return compacted;
}

function getExtensionStorage(): {
	getExtensionUserConfig?: (key: string) => unknown;
	setExtensionUserConfig?: (key: string, value: unknown) => unknown;
} | undefined {
	try {
		const storage = eda?.sys_Storage;
		if (!storage || typeof storage !== 'object') {
			return undefined;
		}
		return storage;
	}
	catch {
		return undefined;
	}
}

function truncateReportText(value: string | undefined): string | undefined {
	const text = normalizeText(value);
	if (text.length === 0) {
		return undefined;
	}
	return text.length > EDA_LOG_REPORT_TEXT_LIMIT
		? `${text.slice(0, EDA_LOG_REPORT_TEXT_LIMIT)}...`
		: text;
}

function formatReportPart(label: string, value: string | undefined): string | undefined {
	const normalizedValue = truncateReportText(value);
	return normalizedValue ? `${label}=${normalizedValue}` : undefined;
}

/**
 * Bridge 日志主管道。
 */
export class BridgeLogPipeline {
	private readonly logs: UnifiedLogEntry[] = [];
	private listener: BridgeLogListener | undefined;
	private hasLoadedStoredLogs = false;
	private storageWritePending = false;
	private storageWriteRequested = false;

	/**
	 * 获取统一日志字段定义。
	 * @returns 字段顺序、字段标签与默认可见字段。
	 */
	public getFieldSchema(): UnifiedLogFieldSchema {
		return {
			fieldOrder: [...LOG_FIELD_ORDER],
			fieldLabels: { ...LOG_FIELD_LABELS },
			defaultVisibleFields: [...EDA_DEFAULT_VISIBLE_FIELDS],
		};
	}

	/**
	 * 构造 Bridge 日志。
	 * @param input 构造参数。
	 * @returns 统一日志记录。
	 */
	public createEntry(input: BridgeLogBuildInput): UnifiedLogEntry {
		const now = new Date();
		const timestamp = now.toISOString();
		const displayTime = formatBeijingTimeOnly(now);
		const fields = compactFields({
			timestamp: displayTime,
			level: input.level,
			source: 'bridge',
			version: BRIDGE_VERSION,
			buildDate: BRIDGE_BUILD_DATE,
			buildWatermark: BRIDGE_BUILD_WATERMARK,
			module: input.module,
			event: input.event,
			summary: input.summary,
			message: input.message,
			toolName: input.toolName,
			bridgePath: input.bridgePath,
			edaApi: input.edaApi,
			requestId: input.requestId,
			phase: input.phase,
			runtimeStatus: input.runtimeStatus,
			bridgeStatus: input.bridgeStatus,
			bridgeWebSocketUrl: redactBridgeWebSocketUrl(input.bridgeWebSocketUrl),
			host: input.host,
			port: input.port,
			contextKey: input.contextKey,
			clientId: input.clientId,
			activeClientId: input.activeClientId,
			leaseTerm: input.leaseTerm,
			bridgeClientCount: input.bridgeClientCount,
			detail: input.detail,
			errorCode: input.errorCode,
			errorName: input.errorName,
			errorStack: input.errorStack,
		});

		return {
			id: createLogId(timestamp, input.event, input.module),
			timestamp,
			level: input.level,
			fields,
		};
	}

	/**
	 * 追加日志到本地缓存并通知监听器。
	 * @param logEntry 日志实体。
	 * @returns 原日志实体。
	 */
	public append(logEntry: UnifiedLogEntry): UnifiedLogEntry {
		this.loadStoredLogs();
		this.logs.push(logEntry);
		if (this.logs.length > BRIDGE_LOG_LIMIT) {
			this.logs.splice(0, this.logs.length - BRIDGE_LOG_LIMIT);
		}
		this.persistDetailedLogs();

		if (this.listener) {
			try {
				this.listener(logEntry);
			}
			catch {
				// 日志监听异常不影响本地日志写入。
			}
		}

		return logEntry;
	}

	/**
	 * 获取完整诊断日志。该数据包含异常堆栈，仅用于本地存储和程序化诊断。
	 */
	public getLogs(): UnifiedLogEntry[] {
		this.loadStoredLogs();
		return this.logs.slice();
	}

	/**
	 * 清空本地完整诊断日志。
	 */
	public clearLogs(): void {
		this.logs.splice(0, this.logs.length);
		this.persistDetailedLogs();
	}

	/**
	 * 将完整日志转换为 EDA 界面使用的简略报告行。
	 * @param logEntry 完整日志实体。
	 * @returns 不包含异常堆栈的摘要文本。
	 */
	public formatEdaReportLine(logEntry: UnifiedLogEntry): string {
		const fields = logEntry.fields;
		const watermark = fields.buildWatermark || [fields.version, fields.buildDate].filter(Boolean).join(' | ');
		const context = [
			formatReportPart('工具', fields.toolName),
			formatReportPart('路由', fields.bridgePath),
			formatReportPart('API', fields.edaApi),
			formatReportPart('阶段', fields.phase),
			formatReportPart('请求', fields.requestId),
			formatReportPart('错误码', fields.errorCode),
			formatReportPart('错误', fields.message),
		].filter((part): part is string => Boolean(part));
		const prefix = [
			fields.timestamp || logEntry.timestamp,
			`[${logEntry.level}]`,
			watermark,
			fields.summary || fields.event || 'Bridge 日志',
		].filter(Boolean).join(' ');
		return context.length > 0 ? `${prefix} | ${context.join(' | ')}` : prefix;
	}

	/**
	 * 获取 EDA 界面展示的简略报告，不包含异常堆栈等详细字段。
	 * @returns 最近的摘要报告文本。
	 */
	public getEdaReport(): string {
		return this.getLogs()
			.slice(-EDA_LOG_REPORT_LIMIT)
			.map(logEntry => this.formatEdaReportLine(logEntry))
			.join('\n');
	}

	/**
	 * 设置日志监听器。
	 * @param listener 监听回调。
	 */
	public setListener(listener: BridgeLogListener | undefined): void {
		this.listener = listener;
	}

	/**
	 * 格式化日志为可输出文本。
	 * @param logEntry 日志实体。
	 * @returns JSON 字符串。
	 */
	public format(logEntry: UnifiedLogEntry): string {
		return JSON.stringify({
			id: logEntry.id,
			timestamp: logEntry.timestamp,
			level: logEntry.level,
			...logEntry.fields,
		});
	}

	/**
	 * 校验统一日志结构。
	 * @param value 待校验对象。
	 * @returns 是否为合法日志。
	 */
	public isUnifiedLogEntry(value: unknown): value is UnifiedLogEntry {
		if (!value || typeof value !== 'object') {
			return false;
		}

		const recordValue = value as Record<string, unknown>;
		if (typeof recordValue.id !== 'string' || normalizeText(recordValue.id).length === 0) {
			return false;
		}
		if (typeof recordValue.timestamp !== 'string' || normalizeText(recordValue.timestamp).length === 0) {
			return false;
		}
		if (recordValue.level !== 'info' && recordValue.level !== 'success' && recordValue.level !== 'warning' && recordValue.level !== 'error') {
			return false;
		}
		if (!recordValue.fields || typeof recordValue.fields !== 'object' || Array.isArray(recordValue.fields)) {
			return false;
		}

		return true;
	}

	/**
	 * 判断日志是否属于连接信息类日志。
	 * @param logEntry 要判断的日志记录。
	 * @returns 是否为连接信息日志。
	 */
	public isConnectionInfoLog(logEntry: UnifiedLogEntry): boolean {
		const fields = logEntry.fields;
		const event = String(fields.event ?? '').trim();
		if (event.startsWith('status.role.') || event.startsWith('status.connect') || event.includes('bridge.websocket')) {
			return true;
		}

		return ['clientId', 'activeClientId', 'bridgeClientCount', 'leaseTerm']
			.some(fieldKey => String(fields[fieldKey] ?? '').trim().length > 0);
	}

	private loadStoredLogs(): void {
		if (this.hasLoadedStoredLogs) {
			return;
		}

		const storage = getExtensionStorage();
		if (!storage || typeof storage.getExtensionUserConfig !== 'function') {
			return;
		}
		this.hasLoadedStoredLogs = true;

		try {
			const raw = storage.getExtensionUserConfig(BRIDGE_DIAGNOSTIC_LOG_STORAGE_KEY);
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				return;
			}
			const stored = raw as Partial<StoredBridgeDiagnosticLogs>;
			if (stored.schemaVersion !== 1 || !Array.isArray(stored.logs)) {
				return;
			}
			const validLogs = stored.logs.filter(logEntry => this.isUnifiedLogEntry(logEntry));
			const existingIds = new Set(this.logs.map(logEntry => logEntry.id));
			this.logs.push(...validLogs.filter(logEntry => !existingIds.has(logEntry.id)).slice(-BRIDGE_LOG_LIMIT));
			if (this.logs.length > BRIDGE_LOG_LIMIT) {
				this.logs.splice(0, this.logs.length - BRIDGE_LOG_LIMIT);
			}
		}
		catch {
			this.hasLoadedStoredLogs = false;
			// 本地日志读取失败不影响 Bridge 运行。
		}
	}

	private persistDetailedLogs(): void {
		if (this.storageWritePending) {
			this.storageWriteRequested = true;
			return;
		}

		const storage = getExtensionStorage();
		if (!storage || typeof storage.setExtensionUserConfig !== 'function') {
			return;
		}

		this.storageWritePending = true;
		const snapshot: StoredBridgeDiagnosticLogs = {
			schemaVersion: 1,
			updatedAt: new Date().toISOString(),
			logs: this.logs.slice(-BRIDGE_LOG_LIMIT),
		};
		let writeResult: unknown;
		try {
			writeResult = storage.setExtensionUserConfig(BRIDGE_DIAGNOSTIC_LOG_STORAGE_KEY, snapshot);
		}
		catch {
			this.storageWritePending = false;
			return;
		}
		void Promise.resolve(writeResult)
			.catch(() => {
				// 本地日志写入失败不影响 Bridge 运行。
			})
			.finally(() => {
				this.storageWritePending = false;
				if (this.storageWriteRequested) {
					this.storageWriteRequested = false;
					this.persistDetailedLogs();
				}
			});
	}
}

export const bridgeLogPipeline = new BridgeLogPipeline();

export function getEdaLogReport(): string {
	return bridgeLogPipeline.getEdaReport();
}

export function clearEdaDiagnosticLogs(): void {
	bridgeLogPipeline.clearLogs();
}
