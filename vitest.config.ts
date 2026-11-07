import { defineConfig } from "vitest/config";

// The SDK's translation provider and hooks must use the same React runtime as the views under test.
export default defineConfig({ test: { server: { deps: { inline: [/@getpaseo\/plugin\/dist\/client\/(index|host|translations)\.js$/] } } } });
