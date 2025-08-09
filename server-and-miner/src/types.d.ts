export interface TransactionParams {
  from: string;
  to: string;
  amount: number;
}

export interface BlockParams {
  index: number;
  prevHash: string;
  timeStamp: number; // in ms
  transaction: TransactionParams[];
  nonce: number;
  hash: string,
}

export type WSMsgType =
  | { type: "TX"; data: Record<any, any> }
  | { type: "BLOCK"; data: BlockParams }   // inserts a block and returns that block    
  | { type: "CHAIN_REQUEST" }                 // request entire chain
  | { type: "CHAIN_RESPONSE"; data: BlockParams[] }   // return entire chain
  | { type: "CHAIN_UPDATE"; data: BlockParams[] };
