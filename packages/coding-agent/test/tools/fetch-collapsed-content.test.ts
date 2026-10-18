import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";

it("keeps product facts behind a clickable accordion without exposing script or template content", async () => {
	const html = `<!doctype html><html><body><main>
<h1>Product information</h1>
<p>Details about this office chair, its materials, dimensions, and assembly requirements are available in the product information panels below.</p>
<a class="a-expander-header" href="javascript:void(0)">Item details</a>
<div class="a-expander-content" style="display:none"><table>
<tr><td>Brand</td><td>Wakefit</td></tr>
<tr><td>Country of Origin</td><td>India</td></tr>
</table></div>
<a class="a-expander-header" href="javascript:void(0)">User guide</a>
<div class="a-expander-content" hidden><table><tr><td>Is Assembly Required?</td><td>No</td></tr></table></div>
<template>Unrendered product claim</template><script>Unrendered script claim</script>
</main></body></html>`;

	const result = await renderHtmlToText(
		"https://example.com/product",
		html,
		5,
		Settings.isolated({ "providers.fetch": "native" }),
		undefined,
		null,
	);

	expect(result.method).toBe("native");
	expect(result.content).toContain("Item details");
	expect(result.content).toMatch(/\| Brand\s+\| Wakefit\s+\|/);
	expect(result.content).toMatch(/\| Country of Origin\s+\| India\s+\|/);
	expect(result.content).toMatch(/\| Is Assembly Required\?\s+\| No\s+\|/);
	expect(result.content).not.toContain("Unrendered product claim");
	expect(result.content).not.toContain("Unrendered script claim");
});
