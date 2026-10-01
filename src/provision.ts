import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
async function provision(): Promise<void> {
    process.umask(0o077);
    const id = process.argv[2];
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
        throw new Error('Usage: npm run provision -- application-id');
    }
    const file = resolve(process.env.APP_CREDENTIALS_FILE ?? './data/applications.json');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let registry: Record<string, string> = {};
    try {
        registry = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw e;
        }
    }
    if (registry[id]) {
        throw new Error('Application already registered. Remove its digest explicitly to rotate.');
    }
    const token = randomBytes(32).toString('base64url');
    const credentialDirectory = join(dirname(file), 'credentials');
    await mkdir(credentialDirectory, {recursive:true,mode:0o700});
    const tokenFile = join(credentialDirectory, `${id}.token`);
    await writeFile(tokenFile, token + '\n', {mode:0o600,flag:'wx'});
    registry[id] = createHash('sha256').update(token).digest('hex');
    await writeFile(`${file}.tmp`, JSON.stringify(registry, null, 2), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    console.log(`Application ${id} provisioned. Credential saved privately to ${tokenFile}. Install it in Laravel server secrets, then delete this token file. No token was logged.`);
}
void provision().catch(() => {
    console.error("Provisioning failed. Check application ID, existing registration and writable storage.");
    process.exit(1);
});
