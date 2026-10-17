import { pickElectronTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import puppeteer, { type ConnectionTransport, TimeoutError } from "puppeteer-core";

// The regression only exists once minification renames Puppeteer's timeout class.
if (TimeoutError.name === "TimeoutError") throw new Error("Puppeteer's timeout class was not minified");

const relay = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		return new URL(request.url).pathname === "/json/version" ? new Response("") : Response.json([]);
	},
});

/** A connected CDP browser with no targets, as the relay presents one whose tabs are all internal pages. */
const transport: ConnectionTransport = {
	send(message) {
		const { id, method } = JSON.parse(message) as { id: number; method: string };
		const result = method === "Target.getBrowserContexts" ? { browserContextIds: [] } : {};
		queueMicrotask(() => transport.onmessage?.(JSON.stringify({ id, result })));
	},
	close() {
		transport.onclose?.();
	},
};

const browser = await puppeteer.connect({ transport, defaultViewport: null });
try {
	await pickElectronTarget(browser, { relayJson: `http://127.0.0.1:${relay.port}` });
	throw new Error("A relay with no eligible tabs unexpectedly found a page");
} catch (error) {
	if (!(error instanceof ToolError)) throw error;
	process.stdout.write(error.message);
} finally {
	await browser.disconnect();
	await relay.stop(true);
}
