import path from "path";
import { BlockParams } from "../types";
import { calculateBlockHash } from "./helper";

const genesis: BlockParams = {
  index: 0,
  timeStamp: Date.now(),
  prevHash: "0",
  nonce: 0,
  hash: "",
  transaction: [],
};

genesis.hash = calculateBlockHash(genesis);

const constants = {
  PORT: 5000,
  DIFFICULTY: 2,
  REQUIRED_NONCE: "",
  GENESIS_BLOCK: genesis,
  BEST_CHAIN: [genesis],
  MINER_PORT: 5050,
  CLIENT_PORT: 6000,
  MINER_REWARD: 50,
  MINER_CHAIN_FILE: path.join("temp","miner-chain.json"),
  MINER_KEY_FILE: path.join("temp","miner-key.json")
};

constants.REQUIRED_NONCE = "0".repeat(constants.DIFFICULTY);

export default constants;
