import websocket from "ws"
import constants from "./utiils/constants"
import { BlockParams, WSMsgType } from "./types"
import { calculateBlockHash } from "./utiils/helper";

const wss = new websocket.Server({
    port: constants.PORT
}, () => {
    console.log(`Server started : ws://localhost:${constants.PORT}`);
    console.log(`Genesis Block: ${JSON.stringify(constants.GENESIS_BLOCK,null,2)}\n`);
})

wss.on("connection",(ws) => {
    console.log("Peer connected to Server");
    // Whenever connected send them a message
    sendDirectMessage({type: "CHAIN_RESPONSE", data: constants.BEST_CHAIN}, ws);

    ws.on("message",(raw) => {
        const msg = JSON.parse(raw.toString()) as WSMsgType;
        switch (msg.type) {
            case "CHAIN_REQUEST":
                sendDirectMessage({type: "CHAIN_RESPONSE", data: constants.BEST_CHAIN}, ws);
                break;
            case "CHAIN_UPDATE":
                insertIntoChain(msg.data);
                break;
            case "BLOCK":
                insertBlock(msg.data);
                break;
            case "TX":
                broadCast(msg,ws)
                break;
        }
    })
})


function broadCast(msg: WSMsgType, except?: websocket) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client !== except) {
            client.send(JSON.stringify(msg));
        }
    });
}

function sendDirectMessage(msg:WSMsgType,ws:websocket) {
    ws.send(JSON.stringify(msg));
}

function insertIntoChain(newChain: BlockParams[]) {
    if (newChain.length <= constants.BEST_CHAIN.length) return;
    if (newChain[0].hash !== constants.BEST_CHAIN[0].hash) return;

    let forkIndex = -1;
    const bestChainMap = new Map<string,number>();
    
    for (let i=constants.BEST_CHAIN.length-1; i>=0; i--){
        const bestchainBlock = constants.BEST_CHAIN[i];
        const newChainBlock = newChain[i];
        bestChainMap.set(bestchainBlock.hash,i);
        const foundIdx = bestChainMap.has(newChainBlock.hash);
        if (foundIdx){
            forkIndex = bestChainMap.get(newChainBlock.hash);
            break;
        }
    }

    if (forkIndex == -1) return;

    for (let i=forkIndex+1; i<=newChain.length; i++){
        const prevBlock = newChain[i-1], currBlock = newChain[i];
        if (currBlock.prevHash !== prevBlock.hash) return;
        if (calculateBlockHash(currBlock) !== currBlock.hash) return;
        if (!currBlock.hash.startsWith(constants.REQUIRED_NONCE)) return;
    }

    constants.BEST_CHAIN = newChain;
    broadCast({type: "CHAIN_RESPONSE",data: constants.BEST_CHAIN})
}

function insertBlock(block: BlockParams) {
    const lenBestChain = constants.BEST_CHAIN.length;
    const lastBestBlock = constants.BEST_CHAIN[lenBestChain-1];
    if (block.prevHash === lastBestBlock.hash){
        if (block.hash != calculateBlockHash(block)) return;
        if (!block.hash.startsWith(constants.REQUIRED_NONCE)) return;
        constants.BEST_CHAIN.push(block);
        broadCast({type: "BLOCK", data: block});
    }
    else {
        // Hash don't match, maybe we are missing some block
        broadCast({type: "CHAIN_REQUEST"});
    }
}
