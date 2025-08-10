import fs from "fs";
import { ec } from "elliptic";
import websocket from "ws";
import constants from "./utiils/constants";
import { addressFromPub, calculateBlockHash, sha256 } from "./utiils/helper";
import { BlockParams, TransactionParams, WSMsgType } from "./types";
import { IncomingMessage } from "http";

type WSSocketType = websocket.Server<typeof websocket, typeof IncomingMessage>;

const Ec = new ec("secp256k1");
let chain = [];
let mempool = []; // contains transactions (non-coinbase)
let balances: Map<string, number>;

let minerKey: {
  priv: string;
  pub: string;
};

try {
  if (fs.existsSync(constants.MINER_KEY_FILE))
    minerKey = JSON.parse(fs.readFileSync(constants.MINER_KEY_FILE).toString());
  else {
    throw new Error("MINER_KEY_FILE not found");
  }
} catch (error) {
  const keyPair = Ec.genKeyPair();
  minerKey = { priv: keyPair.getPrivate("hex"), pub: keyPair.getPublic("hex") };
  fs.writeFileSync(constants.MINER_KEY_FILE, JSON.stringify(minerKey));
}

const minerAddress = addressFromPub(minerKey.pub);
console.log("Miner address : ", minerAddress);

try {
  if (fs.existsSync(constants.MINER_CHAIN_FILE)) {
    chain = JSON.parse(fs.readFileSync(constants.MINER_CHAIN_FILE).toString());
  } else throw new Error("MINER_CHAIN_FILE not found");
} catch (error) {
  // do nothing
}

function saveChainToLocal(chain: BlockParams[]) {
  fs.writeFileSync(constants.MINER_CHAIN_FILE, JSON.stringify(chain));
}

function rebuildBalancesFromChain(chain: BlockParams[]) {
  const balanceMap = new Map<string, number>();
  for (const block of chain) {
    for (const transaction of block.transaction) {
      if (transaction.from !== "COINBASE") {
        if (!balanceMap.has(transaction.from))
          balanceMap.set(transaction.from, 0);
        if (!balanceMap.has(transaction.to)) balanceMap.set(transaction.to, 0);

        balanceMap[transaction.from] -= transaction.amount;
        balanceMap[transaction.to] += transaction.amount;
      } else {
        if (!balanceMap.has(transaction.to)) balanceMap.set(transaction.to, 0);
        balanceMap[transaction.to] += transaction.amount;
      }
    }
  }

  return balanceMap;
}
balances = rebuildBalancesFromChain(chain);

function isValidChain(candidate: BlockParams[]) {
  if (!Array.isArray(candidate) || candidate.length === 0) return false;
  if (candidate[0].index !== 0) return false;
  let tmpBalances = {};

  for (let i = 1; i < candidate.length; i++) {
    const curr = candidate[i],
      prev = candidate[i - 1];
    if (curr.prevHash !== prev.hash) return false;
    if (calculateBlockHash(curr) !== curr.hash) return false;
    if (!curr.hash.startsWith(constants.REQUIRED_NONCE)) return false;

    const local = Object.assign({}, tmpBalances);
    for (let tx of curr.transaction) {
      if (tx.from === "COINBASE") {
        local[tx.to] = (local[tx.to] || 0) + tx.amount;
        continue;
      }
      try {
        // generates a verifier by the transaction public key
        const key = Ec.keyFromPublic(tx.publicKey, "hex");
        const msg = sha256(tx.from + tx.to + tx.amount + tx.timestamp);
        if (!key.verify(msg, tx.signature)) return false;
        if (addressFromPub(tx.publicKey) !== tx.from) return false;
      } catch (e) {
        return false;
      }

      // If sender didn't had money how would he send
      if ((local[tx.from] || 0) < tx.amount) return false;
      local[tx.from] -= tx.amount;
      local[tx.to] = (local[tx.to] || 0) + tx.amount;
    }
    tmpBalances = local;
  }
  return true;
}

function tryAddBlock(b: BlockParams) {
  const last = chain[chain.length - 1];
  if (b.prevHash !== last.hash) return false;
  if (calculateBlockHash(b) !== b.hash) return false;
  if (!b.hash.startsWith(constants.REQUIRED_NONCE)) return false;

  const local = Object.assign({}, balances);
  for (let tx of b.transaction) {
    if (tx.from === "COINBASE") {
      local[tx.to] = (local[tx.to] || 0) + tx.amount;
      continue;
    }
    try {
      const key = Ec.keyFromPublic(tx.publicKey, "hex");
      const msg = sha256(tx.from + tx.to + tx.amount + tx.timestamp);
      // Checks if the transaction was done by this key
      if (!key.verify(msg, tx.signature)) return false;
      if (addressFromPub(tx.publicKey) !== tx.from) return false;
    } catch (e) {
      return false;
    }

    if (!local[tx.from]) local[tx.from] = 0;
    if (local[tx.from] < tx.amount) return false;
    local[tx.from] -= tx.amount;
    local[tx.to] = (local[tx.to] || 0) + tx.amount;
  }
  chain.push(b);
  balances = local;

  // remove included txs from mempool
  const actualTxn = b.transaction.filter((tx) => tx.from !== "COINBASE");
  const transactionSet = new Set(
    actualTxn.map((tx) => sha256(JSON.stringify(tx)))
  );
  const transactionNotInMempool = mempool.filter((tx) => {
    const memTxHash = sha256(tx);
    if (!transactionSet.has(memTxHash)) return true;
  });
  mempool = transactionNotInMempool;
  // persistChain();
  saveChainToLocal(chain);
  console.log("Accepted block", b.index);
  return true;
}

function replaceChain(candidate: BlockParams[]) {
  // Ensure genesis matches
  if (!Array.isArray(candidate) || candidate.length === 0) return false;
  if (candidate[0].hash !== chain[0].hash) {
    // different genesis — reject (safety)
    console.log("replaceChain: candidate genesis differs; rejecting");
    return false;
  }

  // build map of local hashes to indices
  const localIndexByHash = new Map();
  for (let i = 0; i < chain.length; i++) localIndexByHash.set(chain[i].hash, i);

  // find the highest common ancestor (latest block that exists in both chains)
  let forkIndexLocal = -1;
  let forkIndexCandidate = -1;
  for (let i = candidate.length - 1; i >= 0; i--) {
    const h = candidate[i].hash;
    if (localIndexByHash.has(h)) {
      forkIndexLocal = localIndexByHash.get(h);
      forkIndexCandidate = i;
      break;
    }
  }

  if (forkIndexLocal === -1) {
    console.log("replaceChain: no common ancestor found; rejecting candidate");
    return false;
  }

  // compute simple "work" as number of blocks after fork (works when difficulty per block is constant)
  const localWork = chain.length - (forkIndexLocal + 1);
  const candidateWork = candidate.length - (forkIndexCandidate + 1);

  if (candidateWork <= localWork) {
    console.log(
      "replaceChain: candidate does not have more work than local branch; rejecting"
    );
    return false;
  }

  // validate the candidate chain fully before switching
  if (!isValidChain(candidate)) {
    console.log("replaceChain: candidate failed full validation; rejecting");
    return false;
  }

  // acceptable: replace local chain with candidate
  chain = candidate;
  balances = rebuildBalancesFromChain(chain);
  saveChainToLocal(chain);
  console.log("Replaced chain; new len", chain.length);
  return true;
}

let mining = false;

/*
wsToCentral: socket connection
walletWSS: socket server
*/
async function mineOnce(wsToCentral: websocket, walletWSS: WSSocketType) {
  if (mining) return;
  mining = true;
  const last = chain[chain.length - 1];
  const index = last.index + 1;
  const prevHash = last.hash;
  const chosen = mempool.slice(0, 10);
  const coinbase: TransactionParams = {
    from: "COINBASE",
    to: minerAddress,
    amount: constants.MINER_REWARD,
    timestamp: Date.now(),
  };
  const block: BlockParams = {
    index,
    prevHash,
    timeStamp: Date.now(),
    transaction: [coinbase, ...chosen],
    nonce: 0,
    hash: "",
  };
  // Dummy hash will compute later

  let found = false;
  while (!found) {
    block.nonce++;
    block.timeStamp = Date.now();
    block.hash = calculateBlockHash(block);
    if (block.hash.startsWith(constants.REQUIRED_NONCE)) {
      console.log("Mined block", block.index, block.hash);
      if (tryAddBlock(block)) {
        if (wsToCentral && wsToCentral.readyState === WebSocket.OPEN) {
          wsToCentral.send(JSON.stringify({ type: "BLOCK", data: block }));
        }

        // Send block to all the wallets
        if (walletWSS) {
          walletWSS.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN)
              c.send(JSON.stringify({ type: "BLOCK", data: block }));
          });
        }
      }
      found = true;
      break;
    }

    if (!mining) {
      console.log("Mining aborted");
      return;
    }
    // don't let node freeze
    if (block.nonce % 50000 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  mining = false;
}

function handleIncomingTx(
  tx: TransactionParams,
  wsFrom: websocket,
  wsToCentral: websocket,
  walletWSS: WSSocketType
) {
  if (!tx || !tx.from || !tx.to || !tx.amount || !tx.signature || !tx.publicKey)
    return false;
  if (tx.from === "COINBASE") return false;

  try {
    const key = Ec.keyFromPublic(tx.publicKey, "hex");
    const msg = sha256(tx.from + tx.to + tx.amount + tx.timestamp);
    if (!key.verify(msg, tx.signature)) return false;
    if (addressFromPub(tx.publicKey) !== tx.from) return false;
  } catch (e) {
    return false;
  }

  // quick balance check
  if ((balances[tx.from] || 0) < tx.amount) return false;
  mempool.push(tx);

  // broadcast to central
  if (wsToCentral && wsToCentral.readyState === WebSocket.OPEN)
    wsToCentral.send(JSON.stringify({ type: "TX", data: tx }));

  // broadcast to other wallet clients
  if (walletWSS)
    walletWSS.clients.forEach((c) => {
      if (c !== wsFrom && c.readyState === WebSocket.OPEN)
        c.send(JSON.stringify({ type: "TX", data: tx }));
    });

  return true;
}

// Connect to central
const wsToCentral = new websocket(`ws://localhost:${constants.PORT}`);
wsToCentral.on("open", () => {
  console.log("Connected to central at", constants.PORT);
  wsToCentral.send(JSON.stringify({ type: "CHAIN_REQUEST" }));
});
wsToCentral.on("message", (raw) => {
  let msg: WSMsgType;
  try {
    msg = JSON.parse(raw.toString());
  } catch (e) {
    return;
  }

  switch (msg.type) {
    case "CHAIN_RESPONSE":
      if (Array.isArray(msg.data) && msg.data.length > chain.length) {
        console.log("Got chain from central; attempting replace");
        replaceChain(msg.data);
      }
      break;
    case "TX":
      // Update the transaction to chain shared by peer miners
      if (handleIncomingTx(msg.data, null, wsToCentral, walletWSS))
        console.log("Relayed TX from central");
      else console.log("Rejected relayed TX");
      break;
    case "BLOCK":
      if (!tryAddBlock(msg.data)) {
        console.log("Incoming block did not fit -> request chain");
        wsToCentral.send(JSON.stringify({ type: "CHAIN_REQUEST" }));
      } else {
        mining = false;
      }
      break;

    default:
      break;
  }
});

// Wallet WebSocket server (for browser clients)
const walletWSS = new websocket.Server({ port: constants.CLIENT_PORT }, () =>
  console.log("Miner wallet WS server listening on", constants.CLIENT_PORT)
);

walletWSS.on("connection", (ws) => {
  console.log("Wallet connected to miner", constants.CLIENT_PORT);
  // On connection send the client the new chain
  ws.send(JSON.stringify({ type: "CHAIN_RESPONSE", data: chain }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    switch (msg.type) {
      case "TX":
        if (handleIncomingTx(msg.data, ws, wsToCentral, walletWSS)) {
          ws.send(JSON.stringify({ type: "TX_ACCEPTED", data: msg.data }));
          console.log("Wallet TX accepted");
        } else {
          ws.send(JSON.stringify({ type: "TX_REJECTED", data: msg.data }));
          console.log("Wallet TX rejected");
        }
        break;
      case "CHAIN_REQUEST":
        ws.send(JSON.stringify({ type: "CHAIN_RESPONSE", data: chain }));
        break;
      default:
        break;
    }
  });
});

setInterval(() => { if (!mining) mineOnce(wsToCentral, walletWSS).catch(e => { mining = false; console.error(e); }); }, 1000);