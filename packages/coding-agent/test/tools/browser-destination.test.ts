import { describe, expect, it } from "vitest";
import { browserDestinationRefusal } from "../../src/core/tools/browser-destination.ts";

describe("browser destination", () => {
	it("accepts loopback http and https URLs", () => {
		expect(browserDestinationRefusal("http://127.0.0.1:3000/")).toBeNull();
		expect(browserDestinationRefusal("http://localhost/path")).toBeNull();
		expect(browserDestinationRefusal("https://[::1]/")).toBeNull();
	});

	it("rejects other schemes, public hosts, private hosts, and lookalike names", () => {
		expect(browserDestinationRefusal("http://example.com/")).toMatch(/refused/);
		expect(browserDestinationRefusal("http://10.0.0.1/")).toMatch(/refused/);
		expect(browserDestinationRefusal("file:///tmp/x")).toMatch(/refused/);
		expect(browserDestinationRefusal("http://127.0.0.1.example.com/")).toMatch(/refused/);
	});

	it("rejects a URL that cannot be parsed", () => {
		expect(browserDestinationRefusal("not a url")).toMatch(/refused/);
	});
});
