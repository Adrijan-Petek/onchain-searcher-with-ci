#!/usr/bin/env node
import fs from "fs";
import { ethers } from "ethers";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import pMap from "p-map";

const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ERC721_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const argv = yargs(hideBin(process.argv))
  .option("rpc", { type: "string", demandOption: true })
  .option("from", { type: "number", demandOption: true })
  .option("to", { type: "string", default: "latest" })
  .option("chunk", { type: "number", default: 500 })
  .option("concurrency", { type: "number", default: 4 })
  .option("out", { type: "string", default: "scan-results.json" })
  .argv;

async function main() {
  const provider = new ethers.JsonRpcProvider(argv.rpc);
  let toBlock = argv.to === "latest" ? (await provider.getBlockNumber()) : parseInt(argv.to, 10);
  const fromBlock = argv.from;
  const chunk = argv.chunk;
  const concurrency = argv.concurrency;

  console.log(`Scanning blocks ${fromBlock} → ${toBlock}`);

  const ranges = [];
  for (let b = fromBlock; b <= toBlock; b += chunk) {
    ranges.push({ from: b, to: Math.min(b + chunk - 1, toBlock) });
  }

  const results = { transfers: [], contracts: {}, addresses: {} };

  const tryERCNameSymbol = async (addr) => {
    const contract = new ethers.Contract(addr, [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ], provider);
    const out = {};
    try { out.name = await contract.name(); } catch {}
    try { out.symbol = await contract.symbol(); } catch {}
    try { out.decimals = await contract.decimals(); } catch {}
    return out;
  };

  const detectContractHint = (bytecode) => {
    if (!bytecode || bytecode === "0x") return ["EOA"];
    const hints = [];
    const selectors = { "06fdde03": "name()", "95d89b41": "symbol()", "313ce567": "decimals()" };
    const bc = bytecode.replace(/^0x/, "").toLowerCase();
    for (const [sel, name] of Object.entries(selectors)) {
      if (bc.includes(sel)) hints.push(name);
    }
    return hints;
  };

  async function processRange(range) {
    const { from, to } = range;
    const filter = { fromBlock: from, toBlock: to, topics: [[ERC20_TRANSFER_TOPIC, ERC721_TRANSFER_TOPIC]] };
    const logs = await provider.getLogs(filter);
    for (const log of logs) {
      results.transfers.push({ blockNumber: log.blockNumber, txHash: log.transactionHash, tokenAddress: log.address });
      if (!results.contracts[log.address]) results.contracts[log.address] = { name: null, symbol: null };
    }
    const addrs = Object.keys(results.contracts);
    await pMap(addrs, async (addr) => {
      const code = await provider.getCode(addr);
      results.contracts[addr].hints = detectContractHint(code);
      if (code && code !== "0x") {
        const info = await tryERCNameSymbol(addr);
        results.contracts[addr] = { ...results.contracts[addr], ...info };
      }
    }, { concurrency: 5 });
    console.log(`Processed ${from}-${to}`);
  }

  await pMap(ranges, processRange, { concurrency });
  fs.writeFileSync(argv.out, JSON.stringify(results, null, 2));
  console.log(`Results written to ${argv.out}`);
}

main();
