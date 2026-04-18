import { RegistryProvider } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { startupBenchMark } from "./startupBench.js"
import { App } from "./App.js"

startupBenchMark("index_module_loaded")

const renderer = await createCliRenderer({
	exitOnCtrlC: false,
	screenMode: "alternate-screen",
	onDestroy: () => {
		process.exit(0)
	},
})

startupBenchMark("renderer_ready")

createRoot(renderer).render(
	<RegistryProvider>
		<App />
	</RegistryProvider>,
)

startupBenchMark("root_render_called")
