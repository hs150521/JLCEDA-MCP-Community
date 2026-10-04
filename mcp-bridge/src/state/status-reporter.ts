/**
 * ------------------------------------------------------------------------
 * 名称：桥接状态报告器
 * 说明：统一写入连接状态快照，供设置页轮询展示。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：该模块只负责状态写入，不负责网络连接。
 * ------------------------------------------------------------------------
 */

import type { BridgeRole } from '../bridge/protocol.ts';
import { BridgeStateManager } from './state-manager.ts';
import { saveConnectionStatus } from './status-store.ts';

const bridgeStateManager = new BridgeStateManager();

export class BridgeStatusReporter {
	/**
	 * 标记连接初始化中。
	 */
	public markConnecting(): void {
		saveConnectionStatus(bridgeStateManager.createConnectingSnapshot());
	}

	/**
	 * 标记当前角色状态。
	 * @param role 服务端裁决的角色。
	 * @param displayClientId 服务端分配的本客户端展示标识。
	 * @param displayActiveClientId 服务端分配的活动客户端展示标识。
	 */
	public markRole(role: BridgeRole, displayClientId: string, displayActiveClientId: string): void {
		saveConnectionStatus(bridgeStateManager.createRoleSnapshot(role, displayClientId, displayActiveClientId));
	}

	/**
	 * 标记连接失败。
	 * @param detail 失败说明。
	 */
	public markFailed(detail: string): void {
		saveConnectionStatus(bridgeStateManager.createFailedSnapshot(detail));
	}

	/**
	 * 标记当前页面不是原理图、PCB 或封装编辑页，连接已暂停。
	 */
	public markNotOnEditablePage(): void {
		saveConnectionStatus(bridgeStateManager.createNotEditablePageSnapshot());
	}
}
