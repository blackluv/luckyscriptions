Luckyscriptions

A minter and protocol for inscriptions on Luckycoin.

## Setup

**Install dependencies:**

    npm install

**Create a `.env` file with your node information:**

    NODE_RPC_URL=http://<ip>:<port>
    NODE_RPC_USER=<username>
    NODE_RPC_PASS=<password>
    TESTNET=false
    FEE_PER_KB=100000000

## Funding

**Generate a new `.wallet.json` file:**

    node . wallet new

*Then send Luckycoin to the address displayed. Once sent, sync your wallet:*

    node . wallet sync

*If you are minting a lot, you can split up your UTXOs:*

    node . wallet split <count>

*When you are done minting, send the funds back:*

    node . wallet send <address> <optional amount>

## Minting

**From file:**

    node . mint <address> <path>

**Repeating:**

    node . mint <address> <path> <repeat>

**Examples:**

    node . mint L4XbVfcHGaD1tMzjtFAasLmge4LQtggVEG dog.jpeg

    node . mint L4XbVfcHGaD1tMzjtFAasLmge4LQtggVEG mint.json 100

## Starting the Server

**Start the server:**

    node . server

*And open your browser to:*

    http://localhost:3000/tx/15f3b73df7e5c072becb1d84191843ba080734805addfccb650929719080f62e

## Protocol

The Luckyscriptions protocol allows any size data to be inscribed onto subwoofers.

**An inscription is defined as a series of push datas:**

    "ord"
    OP_1
    "text/plain; charset=utf8"
    OP_0
    "Woof!"

**For bellscriptions, we introduce a couple of extensions. First, content may spread across multiple parts:**

    "ord"
    OP_2
    "text/plain; charset=utf8"
    OP_1
    "Woof and "
    OP_0
    "woof woof!"

*This content here would be concatenated as "Woof and woof woof!". This allows up to ~1500 bytes of data per transaction.*

**Second, P2SH is used to encode inscriptions.**

*There are no restrictions on what P2SH scripts may do as long as the redeem scripts start with inscription push datas.*

**And third, inscriptions are allowed to chain across transactions:**

**Transaction 1:**

    "ord"
    OP_2
    "text/plain; charset=utf8"
    OP_1
    "Woof and "

**Transaction 2:**

    OP_0
    "woof woof!"

*With the restriction that each inscription part after the first must start with a number separator, and number separators must count down to 0.*

*This allows indexers to know how much data remains.*

## FAQ

### I'm getting ECONNREFUSED errors when minting

There's a problem with the node connection. Your `dogecoin.conf` file should look something like:

    rpcuser=ape
    rpcpassword=zord
    rpcport=9332
    server=1

*Make sure `port` is not set to the same number as `rpcport`. Also make sure `rpcauth` is not set.*

**Your `.env` file should look like:**

    NODE_RPC_URL=http://127.0.0.1:9332
    NODE_RPC_USER=ape
    NODE_RPC_PASS=zord
    TESTNET=false

### I'm getting "insufficient priority" errors when minting

The miner fee is too low. You can increase it up by putting `FEE_PER_KB=300000000` in your `.env` file or just wait it out. The default is `100000000` but spikes up when demand is high.
