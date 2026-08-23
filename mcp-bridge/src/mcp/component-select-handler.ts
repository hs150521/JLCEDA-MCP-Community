/**
 * ------------------------------------------------------------------------
 * 名称：桥接器件选型任务处理
 * 说明：在 EDA 侧调用器件库搜索接口，返回候选器件列表供上层确认。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-24
 * 备注：仅处理 component/select 任务。
 * ------------------------------------------------------------------------
 */

import { isPlainObjectRecord, parseBoundedIntegerValue, toSafeErrorMessage } from '../utils';
import { debugLog } from '../utils/debug-log.ts';

interface ComponentSelectCandidate {
	uuid: string;
	libraryUuid: string;
	name: string;
	symbolName: string;
	footprintName: string;
	description: string;
	manufacturer: string;
	manufacturerId: string;
	supplier: string;
	supplierId: string;
	lcscInventory: number;
	lcscPrice: number;
}

interface ComponentSelectRequest {
	protocol: string;
	title: string;
	description: string;
	candidates: ComponentSelectCandidate[];
	pageSize: number;
	currentPage: number;
}

interface LibDeviceApi {
	search: (
		keyword: string,
		libraryUuid?: string,
		classification?: unknown,
		symbolType?: unknown,
		itemsOfPage?: number,
		page?: number,
	) => Promise<unknown[]>;
	searchByProperties?: (
		properties: Record<string, string>,
		libraryUuid?: string,
		classification?: string[],
		symbolType?: unknown,
		itemsOfPage?: number,
		page?: number,
	) => Promise<unknown[]>;
	getByLcscIds?: (
		lcscIds: string,
		libraryUuid?: string,
		allowMultiMatch?: boolean,
	) => Promise<unknown[] | unknown>;
}

interface LibLibrariesListApi {
	getSystemLibraryUuid: () => Promise<string | undefined>;
}

const COMPONENT_SELECT_PROTOCOL = 'component-select/v1';
const COMPONENT_SELECT_DEFAULT_LIMIT = 20;
const AMBIGUOUS_VALUE_TOKEN_PATTERN = /^\d+(?:\.\d+)?[kmgunp]$/i;
const LCSC_PART_NUMBER_PATTERN = /^C\d+$/i;
const VALUE_UNIT_REQUIRED_COMPONENT_KEYWORDS: readonly string[] = [
	'电阻',
	'resistor',
	'电容',
	'capacitor',
	'cap',
	'电感',
	'inductor',
];

// 判断当前关键词是否属于电阻/电容/电感这类需要对阻值、容值、感值强制单位的器件。
function keywordRequiresValueUnit(keyword: string): boolean {
	const normalizedKeyword = keyword.toLowerCase();
	return VALUE_UNIT_REQUIRED_COMPONENT_KEYWORDS.some(componentKeyword => normalizedKeyword.includes(componentKeyword));
}

// 检查关键词中是否存在缺少单位符号的数值参数。
function findKeywordTokenMissingUnit(keyword: string): string | null {
	if (!keywordRequiresValueUnit(keyword)) {
		return null;
	}

	const keywordTokens = keyword.split(/\s+/).map(token => token.trim()).filter(Boolean);
	for (const keywordToken of keywordTokens) {
		const normalizedToken = keywordToken.replace(/^[,，;；]+|[,，;；]+$/g, '');
		if (!normalizedToken || !/\d/.test(normalizedToken)) {
			continue;
		}
		if (AMBIGUOUS_VALUE_TOKEN_PATTERN.test(normalizedToken)) {
			return normalizedToken;
		}
	}
	return null;
}

// 将搜索结果项映射为统一候选器件结构。
function mapDeviceSearchItem(raw: unknown, fallbackLibraryUuid = ''): ComponentSelectCandidate {
	const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const symbol = isPlainObjectRecord(item.symbol) ? item.symbol : {};
	const footprint = isPlainObjectRecord(item.footprint) ? item.footprint : {};
	const manufacturerId = String(item.manufacturerId ?? item.manufacturerid ?? '').trim();
	return {
		uuid: String(item.uuid ?? '').trim(),
		libraryUuid: String(item.libraryUuid ?? item.libraryuuid ?? fallbackLibraryUuid).trim(),
		name: String(item.name ?? manufacturerId).trim(),
		symbolName: String(item.symbolName ?? item.symbolname ?? symbol.name ?? '').trim(),
		footprintName: String(item.footprintName ?? item.footprintname ?? footprint.name ?? '').trim(),
		description: String(item.description ?? '').trim(),
		manufacturer: String(item.manufacturer ?? '').trim(),
		manufacturerId,
		supplier: String(item.supplier ?? '').trim(),
		supplierId: String(item.supplierId ?? item.supplierid ?? '').trim(),
		lcscInventory: Number(item.lcscInventory ?? item.lcscinventory ?? 0),
		lcscPrice: Number(item.lcscPrice ?? item.lcscprice ?? 0),
	};
}

// 读取 EDA 器件搜索接口。
function getLibDeviceApi(): LibDeviceApi {
	const libDevice = (eda as unknown as { lib_Device?: unknown }).lib_Device;
	if (!isPlainObjectRecord(libDevice) || typeof libDevice.search !== 'function') {
		throw new Error('未找到 eda.lib_Device.search API，请确认当前 EDA 版本支持器件库搜索。');
	}

	return libDevice as unknown as LibDeviceApi;
}

function getSystemLibraryUuidApi(): LibLibrariesListApi {
	const librariesList = (eda as unknown as { lib_LibrariesList?: unknown }).lib_LibrariesList;
	if (!isPlainObjectRecord(librariesList) || typeof librariesList.getSystemLibraryUuid !== 'function') {
		throw new Error('未找到 eda.lib_LibrariesList.getSystemLibraryUuid API。');
	}
	return librariesList as unknown as LibLibrariesListApi;
}

/**
 * 处理器件选型任务。
 * @param payload 任务参数。
 * @returns 候选器件列表。
 */
export async function handleComponentSelectTask(payload: unknown): Promise<unknown> {
	debugLog('[DEBUG] component-select handler called, payload:', JSON.stringify(payload));
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/select 任务参数必须为对象。');
	}

	const keyword = String(payload.keyword ?? '').trim();
	const rawProperties = payload.properties;
	let properties: Record<string, string> | undefined;
	if (rawProperties !== undefined) {
		if (!isPlainObjectRecord(rawProperties)) {
			throw new TypeError('properties must be an object.');
		}
		const allowedProperties = ['name', 'value', 'symbolName', 'footprintName', 'supplierFootprint', 'supplierId', 'partNumber', 'partCode'];
		properties = {};
		for (const key of allowedProperties) {
			if (rawProperties[key] !== undefined) {
				if (typeof rawProperties[key] !== 'string' || rawProperties[key].trim().length === 0) {
					throw new TypeError(`properties.${key} must be a non-empty string.`);
				}
				properties[key] = rawProperties[key].trim();
			}
		}
		if (Object.keys(properties).length === 0) {
			throw new TypeError('properties must contain at least one supported field.');
		}
	}
	if (keyword.length > 0 && properties) {
		throw new TypeError('Provide either keyword or properties, not both.');
	}
	debugLog('[DEBUG] component-select keyword:', keyword);
	if (keyword.length === 0 && !properties) {
		throw new Error('component_select 缺少 keyword 参数。');
	}

	const keywordTokenMissingUnit = findKeywordTokenMissingUnit(keyword);
	if (keywordTokenMissingUnit) {
		throw new Error(`电阻、电容、电感这类器件的阻值/容值/感值必须带单位符号，检测到“${keywordTokenMissingUnit}”缺少单位。请改为带单位的写法后重试，例如电阻使用 1kΩ，电容使用 100nF，电感使用 10uH。`);
	}

	const limit = parseBoundedIntegerValue(payload.limit, COMPONENT_SELECT_DEFAULT_LIMIT, 2, 20);
	const page = parseBoundedIntegerValue(payload.page, 1, 1, 9999);
	debugLog('[DEBUG] component-select calling getLibDeviceApi');
	const libDevice = getLibDeviceApi();
	debugLog('[DEBUG] component-select got libDevice, calling search');

	let rawResults: unknown[];
	try {
		if (properties) {
			if (typeof libDevice.searchByProperties !== 'function') {
				throw new TypeError('EDA lib_Device.searchByProperties API is unavailable in this client version.');
			}
			rawResults = await libDevice.searchByProperties(properties, undefined, undefined, undefined, limit, page);
		}
		else {
			rawResults = await libDevice.search(keyword, undefined, undefined, undefined, limit, page);
		}
		debugLog('[DEBUG] component-select search returned:', Array.isArray(rawResults) ? rawResults.length : 'not-array', 'items');
	}
	catch (error: unknown) {
		debugLog('[DEBUG] component-select search failed:', error);
		throw new Error(`器件搜索失败：${toSafeErrorMessage(error)}`);
	}

	let usedLcscPartNumberLookup = false;
	let fallbackLibraryUuid = '';
	if (properties && rawResults.length > 0 && rawResults.some(item => !isPlainObjectRecord(item) || typeof item.libraryUuid !== 'string' || item.libraryUuid.trim().length === 0)) {
		try {
			fallbackLibraryUuid = String(await getSystemLibraryUuidApi().getSystemLibraryUuid() ?? '').trim();
		}
		catch (error: unknown) {
			debugLog('[DEBUG] component-select system library lookup failed:', error);
		}
	}
	if (rawResults.length === 0 && LCSC_PART_NUMBER_PATTERN.test(keyword) && typeof libDevice.getByLcscIds === 'function') {
		usedLcscPartNumberLookup = true;
		try {
			const lookupResult = await libDevice.getByLcscIds(keyword.toUpperCase(), undefined, true);
			rawResults = Array.isArray(lookupResult) ? lookupResult : lookupResult ? [lookupResult] : [];
			if (rawResults.length > 0) {
				fallbackLibraryUuid = String(await getSystemLibraryUuidApi().getSystemLibraryUuid() ?? '').trim();
			}
			debugLog('[DEBUG] component-select LCSC part number lookup returned:', rawResults.length, 'items');
		}
		catch (error: unknown) {
			debugLog('[DEBUG] component-select LCSC part number lookup failed:', error);
		}
	}

	if (!Array.isArray(rawResults) || rawResults.length === 0) {
		return {
			ok: false,
			status: usedLcscPartNumberLookup ? 'lcsc_part_not_linked_to_easyeda_library' : 'not_found_in_easyeda_library',
			error: usedLcscPartNumberLookup
				? `LCSC 编号“${keyword.toUpperCase()}”未关联到当前 EasyEDA 器件库，无法获取可放置的符号和封装。`
				: `未在 EasyEDA 器件库中找到匹配“${keyword}”的器件。`,
		};
	}

	const candidates = rawResults
		.map(item => mapDeviceSearchItem(item, fallbackLibraryUuid))
		.filter(item => item.uuid.length > 0 && item.libraryUuid.length > 0);

	if (candidates.length === 0) {
		return {
			ok: false,
			error: '搜索结果缺少必要的 uuid 或 libraryUuid 字段，无法继续选型。',
		};
	}

	const selection: ComponentSelectRequest = {
		protocol: COMPONENT_SELECT_PROTOCOL,
		title: `器件选型：${keyword}`,
		description: `以下是系统库中“${keyword}”的搜索结果，请先确认具体型号后再继续放置。`,
		candidates,
		pageSize: limit,
		currentPage: page,
	};

	return {
		ok: true,
		status: usedLcscPartNumberLookup ? 'lcsc_part_match' : 'indexed_match',
		searchMode: properties ? 'properties' : 'keyword',
		selection,
	};
}
