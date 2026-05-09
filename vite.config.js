import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

const certPath = path.resolve('certs/cert.pem')
const keyPath = path.resolve('certs/key.pem')
const useMkcert =
  fs.existsSync(certPath) && fs.existsSync(keyPath)

const https =
  useMkcert &&
  ({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  })

// Default: @vitejs/plugin-basic-ssl → Chrome shows NET::ERR_CERT_AUTHORITY_INVALID until you proceed anyway.
// Trusted on phone: install mkcert, run `mkcert -install`, then:
//   mkdir -p certs && mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1 ::1 YOUR_LAN_IP
// Copy the CA from `mkcert -CAROOT`/rootCA.pem to your phone and install it as a user CA (Android: Settings → Security → CA certificate).
export default defineConfig({
  plugins: [react(), ...(useMkcert ? [] : [basicSsl()])],
  optimizeDeps: {
    include: ["@tensorflow/tfjs", "@tensorflow-models/blazeface"],
  },
  server: { host: true, ...(https ? { https } : {}) },
  preview: { host: true, ...(https ? { https } : {}) },
})
