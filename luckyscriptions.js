#!/usr/bin/env node

const dogecore = require('./bitcore-lib-luckycoin');
const axios = require('axios');
const path = require('path');
const dotenv = require('dotenv');
const mime = require('mime-types');
const express = require('express');
const { PrivateKey, Address, Transaction, Script, Opcode } = dogecore;
const { Hash, Signature } = dogecore.crypto;

dotenv.config();

if (process.env.TESTNET === 'true') {
    dogecore.Networks.defaultNetwork = dogecore.Networks.testnet;
}

if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB, 10);
} else {
    Transaction.FEE_PER_KB = 100000000;
}

const WALLET_PATH = process.env.WALLET || '.wallet.json';
const PENDING_PATH = WALLET_PATH.replace('wallet', 'pending-txs');

async function main() {
    let cmd = process.argv[2];

    console.log(`Command: ${cmd}`);

    if (cmd === 'mint') {
        if (fs.existsSync(PENDING_PATH)) {
            console.log('Found pending-txs.json. Rebroadcasting...');
            const txs = JSON.parse(fs.readFileSync(PENDING_PATH));
            await broadcastAll(
                txs.map((tx) => new Transaction(tx)),
                false
            );
            return;
        }

        const count = parseInt(process.argv[5], 10);
        if (!isNaN(count)) {
            for (let i = 0; i < count; i++) {
                await mint();
            }
        } else {
            await mint();
        }

        console.log("Broadcast complete.");
    } else if (cmd === 'mint-luckymap') {
        await mintLuckymap();
    } else if (cmd === 'deploy-lky') {
        await deployLky(); 
    } else if (cmd === 'deploy-lky20') {
        await luck20Deploy();
    } else if (cmd === 'mint-lky20') {
        await mintLky20();
    } else if (cmd === 'wallet') {
        await wallet();
    } else if (cmd === 'server') {
        await server();
    } else {
        throw new Error(`Unknown command: ${cmd}`);
    }
}


async function wallet() {
    const subcmd = process.argv[3];

    if (subcmd === 'new') {
        walletNew();
    } else if (subcmd === 'sync') {
        await walletSync();
    } else if (subcmd === 'sync2') {
        await walletSync2();
    } else if (subcmd === 'balance') {
        walletBalance();
    } else if (subcmd === 'send') {
        await walletSend();
    } else if (subcmd === 'split') {
        await walletSplit();
    } else {
        throw new Error(`Unknown subcommand: ${subcmd}`);
    }
}

async function walletSync() {
    let wallet = readWallet();

    console.log('Syncing UTXOs with local Luckycoin node via RPC');

    const body = {
        jsonrpc: "1.0",
        id: "walletsync",
        method: "listunspent",
        params: [0, 9999999, [wallet.address]]  // [minconf, maxconf, [addresses]]
    };

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    };

    try {
        const response = await axios.post(process.env.NODE_RPC_URL, body, options);
        const utxos = response.data.result;

        // Commented out the following lines to remove UTXO debugging information
        // console.log('Fetched UTXOs:', utxos);

        wallet.utxos = utxos.map((e) => ({
            txid: e.txid,
            vout: e.vout,
            satoshis: Math.round(e.amount * 1e8),
            script: Script(new Address(wallet.address)).toHex(),
        }));

        // console.log('Updated wallet UTXOs:', wallet.utxos);

        writeWallet(wallet);

        let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
        console.log(`Balance: ${balance}`);
    } catch (error) {
        console.error('Error syncing wallet:', error.message);
    }
}

async function walletSync2() {
    if (process.env.TESTNET === 'true') throw new Error('No testnet API');

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

    console.log('Syncing UTXOs with minepixel.io');

    let response = await axios.get(`https://luckycoin.minepixel.io/api/address/${wallet.address}`);
    let response1 = await axios.get(`https://luckycoin.minepixel.io/api/address/${wallet.address}/txs`);

    wallet.utxos = [{
        txid: response1.data[0].txid,
        vout: 1,
        satoshis: response.data.chain_stats.funded_txo_sum,
        script: Script(new Address(wallet.address)).toHex(),
    }];

    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
    console.log(`Balance: ${balance}`);
}

function walletBalance() {
    try {
        let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));

        let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);

        console.log(wallet.address, balance);

        // Optionally, write the wallet back to ensure it's up to date
        writeWallet(wallet);
    } catch (error) {
        console.error(`Failed to read or update wallet: ${error.message}`);
    }
}

async function walletSend() {
    const argAddress = process.argv[4];
    const argAmount = process.argv[5];

    let wallet = readWallet();

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
    if (balance === 0) throw new Error('No funds to send');

    let receiver = new Address(argAddress);
    let amount = parseInt(argAmount, 10);

    let tx = new Transaction();
    if (amount) {
        tx.to(receiver, amount);
        console.log('tx', tx);
        fund(wallet, tx);
    } else {
        tx.from(wallet.utxos);
        tx.change(receiver);
        tx.sign(wallet.privkey);
    }

    await broadcast(tx, true);

    console.log(tx.hash);
    writeWallet(wallet);
}

async function walletSplit() {
    let splits = parseInt(process.argv[4], 10);

    let wallet = readWallet();

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0);
    if (balance === 0) throw new Error('No funds to split');

    let tx = new Transaction();
    tx.from(wallet.utxos);
    for (let i = 0; i < splits - 1; i++) {
        tx.to(wallet.address, Math.floor(balance / splits));
    }
    tx.change(wallet.address);
    tx.sign(wallet.privkey);

    await broadcast(tx, true);

    console.log(tx.hash);
    writeWallet(wallet);
}

const MAX_SCRIPT_ELEMENT_SIZE = 520;

async function mintLuckymap() {
    const argAddress = process.argv[3];
    const start = parseInt(process.argv[4], 10);
    const end = parseInt(process.argv[5], 10);
    let address = new Address(argAddress);

    for (let i = start; i <= end; i++) {
        const data = Buffer.from(`${i}.luckymap`, 'utf8');
        const contentType = 'text/plain';

        let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
        let txs = inscribe(wallet, address, contentType, data);
        console.log(`${i}.luckymap`);
        await broadcastAll(txs, false);
    }
}

async function mint() {
    const argAddress = process.argv[3];
    const argContentTypeOrFilename = process.argv[4];
    console.log(`Minting to address: ${argAddress}`);
    console.log(`Content type or filename: ${argContentTypeOrFilename}`);

    let address = new Address(argAddress);
    let contentType;
    let data;

    if (fs.existsSync(argContentTypeOrFilename)) {
        contentType = mime.contentType(mime.lookup(argContentTypeOrFilename));
        data = fs.readFileSync(argContentTypeOrFilename);
        console.log(`File found. Content type: ${contentType}`);
    } else {
        console.error(`File not found: ${argContentTypeOrFilename}`);
        process.exit();
    }

    if (data.length === 0) {
        throw new Error('No data to mint');
    }

    if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
        throw new Error('Content type too long');
    }

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
    console.log('Minting transaction...');
    let txs = inscribe(wallet, address, contentType, data);
    await broadcastAll(txs, false);

    // Sync wallet to update balance
    await walletSync();
    console.log('Minting complete.');
}

async function broadcastAll(txs, retry) {
    let inscriptionTxId = null;

    for (let i = 0; i < txs.length; i++) {
        try {
            console.log(`broadcasting tx ${i + 1} of ${txs.length}`);
            await broadcast(txs[i], retry);
            console.log(`txid: ${txs[i].hash}`);
            if (i === 1) {
                inscriptionTxId = txs[i].hash;
            }
        } catch (e) {
            console.log('❌ Broadcast failed', e);
            fs.writeFileSync(PENDING_PATH, JSON.stringify(txs.slice(i).map((tx) => tx.toString())));
            process.exit(1);
        }
    }

    try {
        fs.rmSync(PENDING_PATH);
    } catch (e) {}

    console.log('✅ Inscription txid:', inscriptionTxId);
    console.log('inscription complete continue to next file.');
    return true;
}

function bufferToChunk(b, type) {
    b = Buffer.from(b, type);
    return {
        buf: b.length ? b : undefined,
        len: b.length,
        opcodenum: b.length <= 75 ? b.length : b.length <= 255 ? 76 : 77,
    };
}

function numberToChunk(n) {
    return {
        buf: n <= 16 ? undefined : n < 128 ? Buffer.from([n]) : Buffer.from([n % 256, n / 256]),
        len: n <= 16 ? 0 : n < 128 ? 1 : 2,
        opcodenum: n === 0 ? 0 : n <= 16 ? 80 + n : n < 128 ? 1 : 2,
    };
}

function opcodeToChunk(op) {
    return { opcodenum: op };
}

const MAX_CHUNK_LEN = 240;
const MAX_PAYLOAD_LEN = 1500;

function inscribe(wallet, address, contentType, data) {
    let txs = [];

    let privateKey = new PrivateKey(wallet.privkey);
    let publicKey = privateKey.toPublicKey();

    let parts = [];
    while (data.length) {
        let part = data.slice(0, Math.min(MAX_CHUNK_LEN, data.length));
        data = data.slice(part.length);
        parts.push(part);
    }

    let inscription = new Script();
    inscription.chunks.push(bufferToChunk('ord'));
    inscription.chunks.push(numberToChunk(parts.length));
    inscription.chunks.push(bufferToChunk(contentType));
    parts.forEach((part, n) => {
        inscription.chunks.push(numberToChunk(parts.length - n - 1));
        inscription.chunks.push(bufferToChunk(part));
    });

    let p2shInput;
    let lastLock;
    let lastPartial;

    while (inscription.chunks.length) {
        let partial = new Script();

        if (txs.length === 0) {
            partial.chunks.push(inscription.chunks.shift());
        }

        while (partial.toBuffer().length <= MAX_PAYLOAD_LEN && inscription.chunks.length) {
            partial.chunks.push(inscription.chunks.shift());
            partial.chunks.push(inscription.chunks.shift());
        }

        if (partial.toBuffer().length > MAX_PAYLOAD_LEN) {
            inscription.chunks.unshift(partial.chunks.pop());
            inscription.chunks.unshift(partial.chunks.pop());
        }

        let lock = new Script();
        lock.chunks.push(bufferToChunk(publicKey.toBuffer()));
        lock.chunks.push(opcodeToChunk(Opcode.OP_CHECKSIGVERIFY));
        partial.chunks.forEach(() => {
            lock.chunks.push(opcodeToChunk(Opcode.OP_DROP));
        });
        lock.chunks.push(opcodeToChunk(Opcode.OP_TRUE));

        let lockhash = Hash.ripemd160(Hash.sha256(lock.toBuffer()));

        let p2sh = new Script();
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_HASH160));
        p2sh.chunks.push(bufferToChunk(lockhash));
        p2sh.chunks.push(opcodeToChunk(Opcode.OP_EQUAL));

        let p2shOutput = new Transaction.Output({
            script: p2sh,
            satoshis: 10000000,
        });

        let tx = new Transaction();
        if (p2shInput) tx.addInput(p2shInput);
        tx.addOutput(p2shOutput);
        fund(wallet, tx);

        if (p2shInput) {
            let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock);
            let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])]);

            let unlock = new Script();
            unlock.chunks = unlock.chunks.concat(lastPartial.chunks);
            unlock.chunks.push(bufferToChunk(txsignature));
            unlock.chunks.push(bufferToChunk(lastLock.toBuffer()));
            tx.inputs[0].setScript(unlock);
        }

        updateWallet(wallet, tx);
        txs.push(tx);

p2shInput = new Transaction.Input({
            prevTxId: tx.hash,
            outputIndex: 0,
            output: tx.outputs[0],
            script: '',
        });

        p2shInput.clearSignatures = () => {};
        p2shInput.getSignatures = () => {};

        lastLock = lock;
        lastPartial = partial;
    }

    let tx = new Transaction();
    tx.addInput(p2shInput);
    tx.to(address, 10000000);
    fund(wallet, tx);

    let signature = Transaction.sighash.sign(tx, privateKey, Signature.SIGHASH_ALL, 0, lastLock);
    let txsignature = Buffer.concat([signature.toBuffer(), Buffer.from([Signature.SIGHASH_ALL])]);

    let unlock = new Script();
    unlock.chunks = unlock.chunks.concat(lastPartial.chunks);
    unlock.chunks.push(bufferToChunk(txsignature));
    unlock.chunks.push(bufferToChunk(lastLock.toBuffer()));
    tx.inputs[0].setScript(unlock);

    updateWallet(wallet, tx);
    txs.push(tx);

    return txs;
}

function fund(wallet, tx) {
    tx.change(wallet.address);
    delete tx._fee;

    for (const utxo of wallet.utxos) {
        if (tx.inputs.length && tx.outputs.length && tx.inputAmount >= tx.outputAmount + tx.getFee()) {
            break;
        }

        delete tx._fee;
        tx.from(utxo);
        tx.change(wallet.address);
        tx.sign(wallet.privkey);
    }

    if (tx.inputAmount < tx.outputAmount + tx.getFee()) {
        throw new Error('Not enough funds');
    }
}

function updateWallet(wallet, tx) {
    wallet.utxos = wallet.utxos.filter((utxo) => {
        for (const input of tx.inputs) {
            if (input.prevTxId.toString('hex') === utxo.txid && input.outputIndex === utxo.vout) {
                return false;
            }
        }
        return true;
    });

    tx.outputs.forEach((output, vout) => {
        if (output.script.toAddress().toString() === wallet.address) {
            wallet.utxos.push({
                txid: tx.hash,
                vout,
                script: Script(new Address(wallet.address)).toHex(),
                satoshis: output.satoshis,
            });
        }
    });
}

const { exec } = require('child_process');
const fs = require('fs');

async function broadcast(tx, retry) {
    const txHex = tx.toString(); // Get raw transaction hex
    const curlCommand = `curl --ssl-no-revoke -X POST -H "Content-Type: text/plain" --data-binary "${txHex}" "https://luckycoin.minepixel.io/api/tx"`;

    // Redirect curl command output to a log file
    const logFile = 'broadcast.log';
    fs.appendFileSync(logFile, `Broadcasting transaction with curl:\n${curlCommand}\n`);

    const body = {
        jsonrpc: "1.0",
        id: 0,
        method: "sendrawtransaction",
        params: [txHex]
    };

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    };

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        try {
            const response = await axios.post(process.env.NODE_RPC_URL, body, options);
            console.log(`✅ Broadcast successful. TXID: ${response.data.result}`);
            return;
        } catch (e) {
            attempts++;
            console.error(`❌ Broadcast failed (attempt ${attempts}):`, e.message);

            if (!retry || attempts >= maxAttempts) {
                throw e;
            }

            let msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message;
            if (msg && msg.includes('too-long-mempool-chain')) {
                console.warn('Retrying due to too-long-mempool-chain error...');
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
            } else {
                throw e;
            }
        }
    }
}

function chunkToNumber(chunk) {
    if (chunk.opcodenum === 0) return 0;
    if (chunk.opcodenum === 1) return chunk.buf[0];
    if (chunk.opcodenum === 2) return chunk.buf[1] * 255 + chunk.buf[0];
    if (chunk.opcodenum > 80 && chunk.opcodenum <= 96) return chunk.opcodenum - 80;
    return undefined;
}

async function extract(txid) {
    let resp = await axios.get(`https://luckycoin.minepixel.io/api/tx/${txid}`);
    let transaction = resp.data.transaction;
    let script = Script.fromHex(transaction.inputs[0].scriptSig.hex);
    let chunks = script.chunks;

    let prefix = chunks.shift().buf.toString('utf8');
    if (prefix !== 'ord') {
        throw new Error('Not a luckinal');
    }

let pieces = chunkToNumber(chunks.shift());
    let contentType = chunks.shift().buf.toString('utf8');
    let data = Buffer.alloc(0);
    let remaining = pieces;

    while (remaining && chunks.length) {
        let n = chunkToNumber(chunks.shift());

        if (n !== remaining - 1) {
            txid = transaction.outputs[0].spent.hash;
            resp = await axios.get(`https://luckycoin.minepixel.io/api/tx/${txid}`);
            transaction = resp.data.transaction;
            script = Script.fromHex(transaction.inputs[0].scriptSig.hex);
            chunks = script.chunks;
            continue;
        }

        data = Buffer.concat([data, chunks.shift().buf]);
        remaining -= 1;
    }

    return {
        contentType,
        data,
    };
}

function server() {
    const app = express();
    const port = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 3000;

    app.get('/tx/:txid', (req, res) => {
        extract(req.params.txid)
            .then((result) => {
                res.setHeader('content-type', result.contentType);
                res.send(result.data);
            })
            .catch((e) => res.send(e.message));
    });

    app.listen(port, () => {
        console.log(`Listening on port ${port}`);
        console.log();
        console.log('Example:');
        console.log(`http://localhost:${port}/tx/15f3b73df7e5c072becb1d84191843ba080734805addfccb650929719080f62e`);
    });
}

async function luck20Deploy() {
    const argAddress = process.argv[3];
    const argTicker = process.argv[4];
    const argMax = process.argv[5];
    const argLimit = process.argv[6];

    const luck20Tx = {
        p: "lky-20",
        op: "deploy",
        tick: `${argTicker.toLowerCase()}`,
        max: `${argMax}`,
        lim: `${argLimit}`
    };

    const data = Buffer.from(JSON.stringify(luck20Tx), 'utf8');
    const contentType = 'application/json';

    let wallet = JSON.parse(fs.readFileSync());
    let txs = inscribe(wallet, argAddress, contentType, data);
    console.log(`Deploy LKY - ${luck20Tx.tick}`);
    await broadcastAll(txs, false);
}

async function walletNew() {
    if (!fs.existsSync(WALLET_PATH)) {
        const privateKey = new PrivateKey();
        const privkey = privateKey.toWIF();
        const address = privateKey.toAddress().toString();
        const json = { privkey, address, utxos: [] };
        fs.writeFileSync(WALLET_PATH, JSON.stringify(json, null, 2));
        console.log('New wallet created with address:', address);
    } else {
        throw new Error('Wallet already exists.');
    }
}

async function mintLky20() {
    const argAddress = process.argv[3];
    const argTicker = process.argv[4];
    const argAmount = process.argv[5];
    const argRepeat = Number(process.argv[6]) || 1;

    const luck20Tx = {
        p: "lky-20",
        op: "mint",
        tick: `${argTicker.toLowerCase()}`,
        amt: `${argAmount}`
    };

    const data = Buffer.from(JSON.stringify(luck20Tx), 'utf8');
    const contentType = 'application/json';

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
    for (let i = 0; i < argRepeat; i++) {
        let txs = inscribe(wallet, argAddress, contentType, data);
        console.log(`Mint LKY - ${luck20Tx.tick}, Amount: ${luck20Tx.amt}, Repeat: ${i + 1}`);
        try {
            await broadcastAll(txs, false);
        } catch (error) {
            console.error(`❌ Broadcast failed (attempt ${i + 1}): ${error.message}`);
        }
    }

    // Sync wallet to update balance
    await walletSync();
}

function writeWallet(wallet) {
    try {
        console.log(`Writing wallet to: ${WALLET_PATH}`);
        fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
        console.log(`Wallet updated: ${WALLET_PATH}`);
    } catch (error) {
        console.error(`Failed to write wallet: ${error.message}`);
    }
}

function readWallet() {
    console.log(`Reading wallet from: ${WALLET_PATH}`);
    return JSON.parse(fs.readFileSync(WALLET_PATH));
}

main().catch((e) => {
    let reason =
        e.response && e.response.data && e.response.data.error && e.response.data.error.message;
    console.error(reason ? `${e.message}: ${reason}` : e.message);
});
