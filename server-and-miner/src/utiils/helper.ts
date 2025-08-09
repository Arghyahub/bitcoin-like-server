import crypto from "node:crypto"
import { BlockParams } from "../types";

export function sha256(input:string) {
    return crypto.createHash("sha256").update(input).digest("hex")
}

type CalcHashType = Omit<BlockParams,'hash'>

export function calculateBlockHash(input:CalcHashType) {
    const hash = sha256(input.index + input.prevHash + input.timeStamp + JSON.stringify(input.transaction) + input.nonce);
    return hash;
}