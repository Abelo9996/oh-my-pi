import { pickElectronTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TimeoutError, type Browser } from "puppeteer-core";

const relay = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		return new URL(request.url).pathname === "/json/version" ? new Response("") : Response.json([]);
	},
});

try {
	const browser = {
		targets: () => [],
		pages: async () => [],
		waitForTarget: async () => {
			const timeout = new TimeoutError("Timed out after waiting 10000ms");
			if (timeout.name === "TimeoutError") throw new Error("Puppeteer's timeout class was not minified");
			throw timeout;
		},
	} as unknown as Browser;
	await pickElectronTarget(browser, { relayJson: `http://127.0.0.1:${relay.port}` });
	throw new Error("A relay with no eligible tabs unexpectedly found a page");
} catch (error) {
	if (!(error instanceof ToolError)) throw error;
	process.stdout.write(error.message);
} finally {
	await relay.stop(true);
}
