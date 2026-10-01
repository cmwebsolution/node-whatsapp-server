import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { Sessions, keyFor, startupDiagnostic, type Driver } from '../src/service.js';
import { createApp } from '../src/app.js';
class Fake extends EventEmitter implements Driver {
    count = 0;
    live = true;
    fail = false;
    async initialize() {
    }
    async destroy() {
        this.live = false;
    }
    async logout() {
    }
    phone() {
        return '919876543210';
    }
    async ready() {
        return this.live;
    }
    async sendMedia() { return this.send(); }
    async send() {
        this.count++;
        if (this.fail) {
            throw new Error('secret exception');
        }
        return 'accepted';
    }
}
async function setup(ttl = 20000) {
    const root = await mkdtemp(join(tmpdir(), 'wa-test-'));
    const clients: Fake[] = [];
    const sessions = new Sessions(root, () => {
        const c = new Fake();
        clients.push(c);
        return c;
    }, ttl);
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const app = createApp(sessions, { a: hash('token-a'), b: hash('token-b') });
    const api = (tenant = 'a', token = `token-${tenant}`) => ({ post: (url: string) => request(app).post(url).set('Authorization', `Bearer ${token}`).set('X-WhatsApp-App-Id', tenant), get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`).set('X-WhatsApp-App-Id', tenant) });
    return { root, clients, sessions, api, app };
}
test('credentials authorize only their application and responses are not cached', async () => {
    const x = await setup();
    assert.equal((await request(x.app).get('/api/whatsapp/u/status')).status, 401);
    assert.equal((await x.api('b', 'token-a').get('/api/whatsapp/u/status')).status, 403);
    const r = await x.api().get('/api/whatsapp/u/status');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.status, 'disconnected');
    await rm(x.root, { recursive: true });
});
test('application and user isolation, concurrent connect and idempotent disconnect', async () => {
    const x = await setup();
    await Promise.all(Array.from({ length: 10 }, () => x.sessions.connect('a', '../same')));
    assert.equal(x.clients.length, 1);
    x.clients[0].emit('ready');
    assert.equal((await x.sessions.status('a', '../same')).status, 'connected');
    assert.equal((await x.sessions.status('b', '../same')).status, 'disconnected');
    assert.equal((await x.sessions.status('a', 'other')).status, 'disconnected');
    await x.sessions.connect('b', '../same');
    assert.equal(x.clients.length, 2);
    await Promise.all([x.sessions.disconnect('a', '../same'), x.sessions.disconnect('a', '../same')]);
    assert.equal((await x.sessions.status('b', '../same')).status, 'connecting');
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('restart restoration starts connecting and only ready reports actual phone', async () => {
    const x = await setup();
    await mkdir(join(x.root, `session-${keyFor('a', 'u')}`));
    await x.sessions.restore();
    assert.equal((await x.sessions.status('a', 'u')).phone, null);
    x.clients[0].emit('ready');
    assert.equal((await x.sessions.status('a', 'u')).phone, '919876543210');
    await x.sessions.shutdown();
    assert.equal((await x.sessions.status('a', 'u')).status, 'disconnected');
    await rm(x.root, { recursive: true });
});
test('QR expiry refreshes and stale client events cannot revive session', async () => {
    const x = await setup(100);
    await x.sessions.connect('a', 'u');
    x.clients[0].emit('qr', 'test');
    await new Promise(r => setTimeout(r, 60));
    const qr = await x.sessions.status('a', 'u', true);
    assert.match(qr.qr!, /^data:image\/png;base64,/);
    assert.ok(qr.qr!.length < 1048576);
    await new Promise(r => setTimeout(r, 100));
    await assert.rejects(x.sessions.status('a', 'u', true), { code: 'QR_EXPIRED' });
    assert.equal(x.clients.length, 2);
    x.clients[0].emit('ready');
    assert.equal((await x.sessions.status('a', 'u')).status, 'connecting');
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('validation, send readiness and uncertain submission has no retry or leaked exception', async () => {
    const x = await setup();
    const endpoint = '/api/whatsapp/u/send-message';
    for (const body of [{ phone: '01234567', message: 'ok' }, { phone: '919876543210', message: ' ' }, { phone: '919876543210', message: 'a'.repeat(4097) }]) {
        assert.equal((await x.api().post(endpoint).send(body)).status, 422);
    }
    const body = { phone: '919876543210', message: 'Hello' };
    assert.equal((await x.api().post(endpoint).send(body)).body.code, 'SESSION_DISCONNECTED');
    await x.sessions.connect('a', 'u');
    assert.equal((await x.api().post(endpoint).send(body)).body.code, 'NOT_CONNECTED');
    x.clients[0].emit('ready');
    x.clients[0].live = false;
    assert.equal((await x.api().post(endpoint).send(body)).status, 409);
    x.clients[0].live = true;
    assert.equal((await x.api().post(endpoint).send(body)).body.message_id, 'accepted');
    x.clients[0].fail = true;
    const r = await x.api().post(endpoint).send(body);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'SEND_FAILED');
    assert.ok(!JSON.stringify(r.body).includes('secret'));
    assert.equal(x.clients[0].count, 2);
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('timed out sends retain connection and block concurrent submission until settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-timeout-'));
    const client = new Fake();
    client.send = async () => {
        client.count++;
        return new Promise(() => {
        });
    };
    const sessions = new Sessions(root, () => client, 20000, 10, 20, 90000, 20);
    await sessions.connect('a', 'u');
    client.emit('ready');
    await assert.rejects(sessions.send('a', 'u', '919876543210', 'hello'), { code: 'SEND_FAILED' });
    client.emit('ready');
    assert.equal((await sessions.status('a', 'u')).status, 'connected');
    await assert.rejects(sessions.send('a', 'u', '919876543210', 'another'), {code:'SEND_IN_PROGRESS'});
    assert.equal(client.count, 1);
    await sessions.shutdown();
    await rm(root, { recursive: true });
});
test('disconnect serializes behind in-flight submission and removes persisted profile', async () => {
    const x = await setup();
    await x.sessions.connect('a', 'u');
    const folder = join(x.root, `session-${keyFor('a', 'u')}`);
    await mkdir(folder);
    x.clients[0].emit('ready');
    let release: (s: string) => void = () => {
    };
    x.clients[0].send = () => new Promise(r => {
        release = r;
    });
    const send = x.sessions.send('a', 'u', '919876543210', 'Hello');
    await new Promise(r => setTimeout(r, 10));
    const disconnect = x.sessions.disconnect('a', 'u');
    release('accepted');
    assert.equal((await send).message_id, 'accepted');
    assert.equal((await disconnect).status, 'disconnected');
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(folder));
    await rm(x.root, { recursive: true });
});
test('opaque URL user IDs, all four tenant/user combinations and invalid bodies', async () => {
    const x = await setup();
    for (const app of ['a', 'b']) {
        for (const id of ['same', '../opaque:☃']) {
            assert.equal((await x.api(app).post('/api/whatsapp/connect').send({ user_id: id })).status, 200);
            x.clients.at(-1)!.emit('ready');
        }
    }
    assert.equal(x.clients.length, 4);
    await x.api('a').post(`/api/whatsapp/${encodeURIComponent('../opaque:☃')}/disconnect`);
    for (const [app, id] of [['a', 'same'], ['b', 'same'], ['b', '../opaque:☃']]) {
        assert.equal((await x.api(app).get(`/api/whatsapp/${encodeURIComponent(id)}/status`)).body.status, 'connected');
    }
    for (const id of [123, '', 'a'.repeat(257)]) {
        assert.equal((await x.api().post('/api/whatsapp/connect').send({ user_id: id })).status, 422);
    }
    assert.equal((await x.api().post('/api/whatsapp/connect').set('Content-Type', 'application/json').send('{bad')).status, 422);
    assert.equal((await x.api().post('/api/whatsapp/connect').send({ user_id: 'a'.repeat(25000) })).status, 422);
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('credential provisioner persists only digests and refuses duplicate app IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-registry-'));
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const path = join(root, 'registry.json');
    const command = new URL('../src/provision.js', import.meta.url);
    const options = { env: { ...process.env, APP_CREDENTIALS_FILE: path } };
    const first = await run(process.execPath, [command.pathname, 'transport'], options);
    assert.ok(!first.stdout.includes('Bearer token'));
    const token = (await (await import('node:fs/promises')).readFile(join(root, 'credentials', 'transport.token'), 'utf8')).trim();
    assert.ok(!first.stdout.includes(token));
    const { readFile, stat } = await import('node:fs/promises');
    const saved = await readFile(path, 'utf8');
    assert.ok(!saved.includes(token));
    assert.equal(JSON.parse(saved).transport, createHash('sha256').update(token).digest('hex'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(run(process.execPath, [command.pathname, 'transport'], options));
    await rm(root, { recursive: true });
});

test('media submissions enforce tenant ownership, readiness and no retry on uncertain failure', async () => {
    const x = await setup();
    const endpoint = '/api/whatsapp/u/send-media';
    const media = { mimetype: 'application/pdf', data: Buffer.from('%PDF-1.7\nattachment').toString('base64'), filename: 'bill.pdf', caption: 'Bill' };
    const body = { phone: '919876543210', media };
    assert.equal((await x.api('b', 'token-a').post(endpoint).send(body)).status, 403);
    assert.equal((await x.api().post(endpoint).send(body)).body.code, 'SESSION_DISCONNECTED');
    await x.sessions.connect('a', 'u');
    assert.equal((await x.api().post(endpoint).send(body)).body.code, 'NOT_CONNECTED');
    x.clients[0].emit('ready');
    assert.equal((await x.api('b').post(endpoint).send(body)).body.code, 'SESSION_DISCONNECTED');
    assert.equal((await x.api().post('/api/whatsapp/other/send-media').send(body)).body.code, 'SESSION_DISCONNECTED');
    const accepted = await x.api().post(endpoint).send(body);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.message_id, 'accepted');
    assert.equal(accepted.headers['cache-control'], 'no-store');
    x.clients[0].fail = true;
    const failed = await x.api().post(endpoint).send(body);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'SEND_FAILED');
    assert.ok(!JSON.stringify(failed.body).includes('secret exception'));
    assert.equal(x.clients[0].count, 2);
    assert.equal((await x.sessions.status('a','u')).status, 'connected');
    x.clients[0].fail = false;
    assert.equal((await x.api().post(endpoint).send(body)).body.message_id, 'accepted');
    assert.equal(x.clients[0].count, 3);
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('media validates type, filename, canonical encoding and bounded content before sending', async () => {
    const x = await setup();
    const endpoint = '/api/whatsapp/u/send-media';
    const pdf = { mimetype: 'application/pdf', data: Buffer.from('%PDF-1.7\nattachment').toString('base64'), filename: 'bill.pdf', caption: 'Bill' };
    for (const media of [null, {...pdf, filename:'../bill.pdf'}, {...pdf, data:'invalid'}, {...pdf, data:Buffer.from('private').toString('base64')}, {...pdf, caption:'a'.repeat(1025)}, {...pdf, mimetype:'image/png'}, {...pdf, data:Buffer.alloc(8*1024*1024+1).toString('base64')}]) {
        assert.equal((await x.api().post(endpoint).send({phone:'919876543210', media})).status, 422);
    }
    const png = { mimetype:'image/png', filename:'bill.png', caption:'Bill', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
    await x.sessions.connect('a','u');
    x.clients[0].emit('ready');
    assert.equal((await x.api().post(endpoint).send({phone:'919876543210',media:png})).status,200);
    const huge = Buffer.from(png.data,'base64');
    huge.writeUInt32BE(20000,16);
    huge.writeUInt32BE(20000,20);
    assert.equal((await x.api().post(endpoint).send({phone:'919876543210',media:{...png,data:huge.toString('base64')}})).status,422);
    assert.equal(x.clients[0].count,1);
    await x.sessions.shutdown();
    await rm(x.root,{recursive:true});
});

test('status recovers a temporarily unready client without needing another ready event', async () => {
    const x = await setup();
    await x.sessions.connect('a', 'u');
    x.clients[0].emit('ready');
    x.clients[0].live = false;
    assert.equal((await x.sessions.status('a', 'u')).status, 'connecting');
    x.clients[0].live = true;
    const restored = await x.sessions.status('a', 'u');
    assert.equal(restored.status, 'connected');
    assert.equal(restored.phone, '919876543210');
    assert.equal(x.clients.length, 1);
    await x.sessions.shutdown();
    await rm(x.root, { recursive: true });
});
test('stalled startup retries once then disconnects without deleting saved credentials', async () => {
    const root = await mkdtemp(join(tmpdir(),'wa-stuck-'));
    const client = new Fake(); client.live = false;
    const sessions = new Sessions(root, () => client, 20000, 100, 15000, 10);
    await mkdir(join(root,`session-${keyFor('a','u')}`));
    await sessions.connect('a','u');
    await new Promise(resolve => setTimeout(resolve,20));
    assert.equal((await sessions.status('a','u')).status,'connecting');
    await new Promise(resolve=>setTimeout(resolve,20));
    const result = await sessions.status('a','u');
    assert.equal(result.status,'disconnected');
    assert.equal(result.phone,null);
    const {readdir} = await import('node:fs/promises');
    assert.ok((await readdir(root)).includes(`session-${keyFor('a','u')}`));
    await sessions.shutdown();
    await rm(root,{recursive:true});
});

test('late acceptance clears only the submission guard and never sends again automatically', async () => {
    const root = await mkdtemp(join(tmpdir(),'wa-late-'));
    const client = new Fake();
    let accept!: (id: string) => void;
    client.send = async () => { client.count++; return new Promise<string>(resolve => { accept = resolve; }); };
    const sessions = new Sessions(root,()=>client,20000,10,20,90000,20);
    await sessions.connect('a','u'); client.emit('ready');
    await assert.rejects(sessions.send('a','u','919876543210','first'),{code:'SEND_FAILED'});
    assert.equal((await sessions.status('a','u')).status,'connected');
    accept('late-accepted'); await new Promise(resolve=>setImmediate(resolve));
    assert.equal(client.count,1);
    client.send = async () => {client.count++; return 'next-accepted';};
    assert.equal((await sessions.send('a','u','919876543210','distinct')).message_id,'next-accepted');
    client.emit('disconnected');
    assert.equal((await sessions.status('a','u')).status,'disconnected');
    await sessions.shutdown(); await rm(root,{recursive:true});
});

test('concurrent HTTP submissions are rejected immediately rather than queued for a late second send', async () => {
    const x=await setup(); await x.sessions.connect('a','u'); x.clients[0].emit('ready');
    let finish!: (id:string)=>void;
    x.clients[0].send = async ()=>{x.clients[0].count++; return new Promise<string>(resolve=>{finish=resolve;});};
    const first=x.sessions.send('a','u','919876543210','first');
    await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(x.sessions.send('a','u','919876543210','second'),{code:'SEND_IN_PROGRESS'});
    assert.equal(x.clients[0].count,1); finish('accepted'); await first;
    await x.sessions.shutdown(); await rm(x.root,{recursive:true});
});

test('repeated authentication neither demotes connected state nor extends a stalled startup forever',async()=>{
    const root=await mkdtemp(join(tmpdir(),'wa-auth-'));const clients:Fake[]=[];
    const sessions=new Sessions(root,()=>{const c=new Fake();c.live=false;clients.push(c);return c;},20000,10,20,10);
    await sessions.connect('a','u');
    await new Promise(resolve=>setTimeout(resolve,20));clients[0].emit('authenticated');
    assert.equal((await sessions.status('a','u')).status,'connecting');assert.equal(clients.length,2);
    clients[1].live=true;clients[1].emit('ready');clients[1].emit('authenticated');
    assert.equal((await sessions.status('a','u')).status,'connected');
    await sessions.shutdown();await rm(root,{recursive:true});
});

test('failed initialization recovers once with a fresh client and ignores retired client events',async()=>{
    const root=await mkdtemp(join(tmpdir(),'wa-init-'));const clients:Fake[]=[];
    const sessions=new Sessions(root,()=>{const c=new Fake();if(!clients.length)c.initialize=async()=>{throw new Error('private startup detail');};clients.push(c);return c;});
    await sessions.connect('a','u');
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(clients.length,2);
    clients[0].emit('ready');assert.equal((await sessions.status('a','u')).status,'connecting');
    clients[1].emit('ready');assert.equal((await sessions.status('a','u')).status,'connected');
    await sessions.shutdown();await rm(root,{recursive:true});
});

test('completed client send without an ID succeeds with explicit confirmation metadata and retains connection',async()=>{
    const root=await mkdtemp(join(tmpdir(),'wa-no-id-'));
    const client=new Fake() as Driver;
    client.send=async()=>null;
    const sessions=new Sessions(root,()=>client);
    await sessions.connect('a','u');client.emit('ready');
    assert.deepEqual(await sessions.send('a','u','919876543210','sample'),{success:true,message_id:null,confirmation:'client_completed'});
    assert.equal((await sessions.status('a','u')).status,'connected');
    await sessions.shutdown();await rm(root,{recursive:true});
});


test('startup diagnostics identify host failures without exposing exception details', () => {
    assert.equal(startupDiagnostic(new Error('Could not find Chrome: private/path secret')).code, 'CHROME_MISSING');
    assert.equal(startupDiagnostic(new Error('error while loading shared libraries: libnss3.so')).code, 'CHROME_DEPENDENCIES');
    assert.equal(startupDiagnostic(new Error('ProcessSingleton profile in use')).code, 'PROFILE_IN_USE');
    assert.ok(!JSON.stringify(startupDiagnostic(new Error('token-secret private startup detail'))).includes('token-secret'));
});

test('waiting for QR scanning does not consume the browser startup timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-qr-startup-'));
    const clients: Fake[] = [];
    let finish!: () => void;
    const sessions = new Sessions(root, () => {
        const c = new Fake();
        c.initialize = () => new Promise<void>(resolve => { finish = resolve; });
        clients.push(c);
        return c;
    }, 20000, 10, 15000, 100);
    await sessions.connect('a', 'u');
    await new Promise(resolve => setTimeout(resolve, 10));
    clients[0].emit('qr', 'private-qr');
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal((await sessions.status('a', 'u', true)).status, 'qr_required');
    assert.equal(clients.length, 1);
    finish();
    await sessions.shutdown();
    await rm(root, { recursive: true });
});

test('failed browser startup exposes a safe reason in status and runtime diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wa-failed-startup-'));
    const entries: unknown[] = [];
    const sessions = new Sessions(root, () => {
        const client = new Fake();
        client.initialize = async () => { throw new Error('Could not find Chrome secret-token'); };
        return client;
    }, 20000, 10, 15000, 90000, 30000, entry => entries.push(entry));
    await sessions.connect('a', 'u');
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await sessions.status('a', 'u');
    assert.equal(result.status, 'disconnected');
    assert.equal(result.last_error?.code, 'CHROME_MISSING');
    assert.equal(entries.length, 2);
    assert.ok(!JSON.stringify(entries).includes('secret-token'));
    await sessions.shutdown();
    await rm(root, { recursive: true });
});
