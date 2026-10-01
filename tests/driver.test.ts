import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import whatsapp from 'whatsapp-web.js';
import {acceptedMessageId,createDriver} from '../src/driver.js';
test('adapter returns accepted IDs for text/PDF/image without waiting for recipient delivery or marking chats read',async()=>{
    const client = new EventEmitter() as whatsapp.Client;
    const calls: {content:unknown;options:whatsapp.MessageSendOptions|undefined}[]=[];
    client.sendMessage = async (_chat,content,options) => {
        calls.push({content,options});
        return {id:{_serialized:'accepted-id'}} as whatsapp.Message;
    };
    client.getState = async () => 'CONNECTED' as whatsapp.WAState;
    const bridge=createDriver(client);
    assert.equal(await bridge.ready(),true);
    assert.equal(await bridge.send('919876543210','sample'),'accepted-id');
    for(const mimetype of ['application/pdf','image/png'] as const) {
        assert.equal(await bridge.sendMedia('919876543210',{mimetype,data:'dGVzdA==',filename:mimetype==='image/png'?'bill.png':'bill.pdf',caption:'Bill'}),'accepted-id');
    }
    for(const call of calls) {
        assert.equal(call.options?.sendSeen,false);
        assert.equal(call.options?.waitUntilMsgSent,true);
    }
    assert.ok(calls[1].content instanceof whatsapp.MessageMedia);
    assert.equal(calls[1].options?.sendMediaAsDocument,true);
    assert.equal(calls[2].options?.sendMediaAsDocument,false);
});

test('accepted message IDs support renamed WhatsApp fields without inventing message IDs for missing responses',()=>{
    assert.equal(acceptedMessageId({id:{$1:'accepted-new'}}),'accepted-new');
    assert.equal(acceptedMessageId({id:{_serialized:'accepted-old'}}),'accepted-old');
    for(const value of [undefined,null,{}, {id:{}},{id:{_serialized:''}}]) assert.equal(acceptedMessageId(value),null);
});

test('send waits for the client send result and propagates failure without resubmitting',async()=>{
    const client=new EventEmitter() as whatsapp.Client;
    let finish!: (result:whatsapp.Message)=>void;let calls=0;let completed=false;
    client.sendMessage=async (_chat,_content,options)=>{
        calls++;assert.equal(options?.waitUntilMsgSent,true);
        return new Promise<whatsapp.Message>(resolve=>{finish=resolve;});
    };
    const bridge=createDriver(client);
    const pending=bridge.send('919876543210','sample').then(id=>{completed=true;return id;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(completed,false);assert.equal(calls,1);
    finish({id:{_serialized:'sent-confirmed'}} as whatsapp.Message);
    assert.equal(await pending,'sent-confirmed');
    client.sendMessage=async()=>{calls++;throw new Error('Client send result failed');};
    await assert.rejects(bridge.send('919876543210','different'));
    assert.equal(calls,2);
});
