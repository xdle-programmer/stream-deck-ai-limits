import type { UsageSnapshot } from "../providers/types.ts";
import type { ProviderAccent, WindowKind } from "../settings/usage-settings.ts";
import { renderUsageIcon } from "./usage-icon.ts";

export interface SingleWindowOptions {
	window: WindowKind;
	providerAccent: ProviderAccent;
	now?: Date;
}

/** The universal action shares the same one-limit layout as provider-specific keys. */
export function renderSingleWindowIcon(snapshot: UsageSnapshot, options: SingleWindowOptions): string {
	return renderUsageIcon(snapshot, options.now, options);
}
