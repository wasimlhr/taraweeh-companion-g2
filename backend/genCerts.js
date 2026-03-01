import selfsigned from 'selfsigned';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, 'certs');
mkdirSync(certsDir, { recursive: true });

const attrs = [{ name: 'commonName', value: 'taraweeh-companion-local' }];
const pems = await selfsigned.generate(attrs, { days: 3650, keySize: 2048 });

writeFileSync(join(certsDir, 'key.pem'), pems.private);
writeFileSync(join(certsDir, 'cert.pem'), pems.cert);
console.log('Certs written to backend/certs/');
