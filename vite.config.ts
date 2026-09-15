import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
	const backend = loadEnv(mode, process.cwd(), 'MOVIDOS_BACKEND_URL').MOVIDOS_BACKEND_URL?.trim()
	if (backend) {
		const target = new URL(backend)
		if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
			throw new Error('MOVIDOS_BACKEND_URL deve ser a origem HTTPS oficial, sem caminho, credenciais ou parametros.')
		}
	}
	const labelApi = /^\/api\/label-(routes|read|volume)(?:\?|$)/
	return {
		plugins: [react(), {
			name: 'local-label-api',
			configureServer(server) {
				if (backend) return
				server.middlewares.use((request, response, next) => {
					if (!labelApi.test(request.url ?? '')) return next()
					response.statusCode = 503
					response.setHeader('Content-Type', 'application/json; charset=utf-8')
					response.setHeader('Cache-Control', 'no-store')
					response.end(JSON.stringify({ error: 'O backend do leitor não está conectado à prévia local. Configure MOVIDOS_BACKEND_URL com a origem HTTPS oficial e reinicie o servidor. A leitura e a gravação de pré-rotas usarão esse ambiente.' }))
				})
			},
		}],
		server: {
			watch: { ignored: ['**/tmp/**'] },
			proxy: backend ? { [labelApi.source]: { target: backend, changeOrigin: true, secure: true } } : undefined,
		},
	}
})
