import { readFileSync } from 'node:fs'
export default JSON.parse(readFileSync(new URL('../data/esm-loadtime.json', import.meta.url), 'utf8'))
