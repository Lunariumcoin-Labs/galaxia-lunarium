// Usage: node backend/tools/build-collateral-registry.js
// Builds backend/masternode-collateral.json: for every coin of the "Coins masternode" tab, where its
// collateral is defined in the official source code (repository, file, pattern) and the value read
// there now. Review the printed values against the code before deploying the file.
const fs = require('fs');
const path = require('path');

const RULES = {
  XLN: { repo: 'Lunariumcoin-Labs/LunariumCoin', file: 'src/masternode.cpp', rule: 'schedule_gt', section: 'CAmount CMasternode::GetMasternodeNodeCollateral', pattern: 'nHeight >\\s*(\\d+)\\) return\\s+(\\d+) \\* COIN', height: { route: '/api/network/xln', field: 'blockCount' } },
  PIVX: { repo: 'PIVX-Project/PIVX', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'consensus\\.nMNCollateralAmt = (\\d+) \\* COIN' },
  MON: { repo: 'MoneyByte/MoneyByteBlockchain', file: 'src/main.h', rule: 'tiers', names: [null], pattern: 'GetMNCollateral\\(int nHeight\\) \\{ return (\\d+); \\}' },
  // VIVO: the code enforces the regular collateral (dmn_types.h: IsCollateralAmount accepts that amount only, 5,000).
  // The EVO class is announced by the project with 20,000 VIVO (doc/VIVO_v25_Masternode_EVO_Operator_Guide_v2.pdf,
  // "Planned EVO collateral"; the site's owner confirmed 5,000 / 20,000 on 2026-10-05), so it is listed from that guide.
  VIVO: { repo: 'KingricharVD/vivo', file: 'src/evo/dmn_types.h', rule: 'tiers', names: ['Regular'], pattern: 'collat_amount = (\\d+) \\* COIN',
    extra_tiers: [{ name: 'Evo', amount: 20000, source: 'doc/VIVO_v25_Masternode_EVO_Operator_Guide_v2.pdf' }] },
  DASH: { repo: 'dashpay/dash', file: 'src/evo/dmn_types.h', rule: 'tiers', names: ['Regular', 'Evo'], pattern: 'collat_amount = (\\d+) \\* COIN' },
  DFCN: { repo: 'defcon-project/defcon', file: 'src/chainparams.cpp', rule: 'tiers', names: ['Regular', 'Evo', 'Compute'], pattern: 'consensus\\.(?:regular|evo|compute)MnCollateral = (\\d+) \\* COIN' },
  FBC: { repo: 'didarmetu/Fibercoin', file: 'src/masternode.h', rule: 'tiers', names: [null], pattern: '#define MASTERNODE_COLLATERAL (\\d+)' },
  FIRO: { repo: 'firoorg/firo', file: 'src/evo/providertx.cpp', rule: 'tiers', names: [null], pattern: 'coin\\.out\\.nValue != (\\d+) \\* COIN' },
  FLUX: { repo: 'RunOnFlux/fluxd', file: 'src/fluxnode/fluxnode.h', rule: 'tiers', names: ['Cumulus', 'Nimbus', 'Stratus'], pattern: '#define V2_FLUXNODE_COLLAT_\\w+ (\\d+)' },
  FREED: { repo: 'FreedomCoin-Project/FreedomCoin-Core', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'consensus\\.nPNCollateralAmt = (\\d+) \\* COIN' },
  MARIA: { repo: 'hostmaria/mariacoin', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'consensus\\.nMNCollateralAmt = (\\d+) \\* COIN' },
  N808: { repo: 'didarmetu/New808coin', file: 'src/masternode.h', rule: 'tiers', names: [null], pattern: '#define MASTERNODE_COLLATERAL (\\d+)' },
  PAC: { repo: 'pacprotocol/pacprotocol', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'consensus\\.nMasternodeCollateral = (\\d+) \\* COIN' },
  PIRATE: { repo: 'piratecash/piratecash', file: 'src/evo/dmn_types.h', rule: 'tiers', names: ['Regular', 'Evo'], pattern: 'collat_amount = (\\d+) \\* COIN' },
  SCC: { repo: 'stakecube/stakecubecoin-archive', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'nRequiredMasternodeCollateral = (\\d+);' },
  SKYR: { repo: 'SkynetResearchProject/Skyrcoin', file: 'src/masternode.cpp', rule: 'tiers', names: [null], section: 'CAmount CMasternode::GetMasternodeNodeCollateral', pattern: '^\\s*return (\\d+) \\* COIN;' },
  VQR: { repo: 'cryptadev/vqr', file: 'src/chainparams.cpp', rule: 'tiers', names: [null], pattern: 'consensus\\.nMasternodeAmountLock = (\\d+);' },
  FSC: { repo: 'fsocietychain/fsociety', file: 'src/chainparams.cpp', rule: 'schedule_le', section: 'consensus.nCollaterals = SmartnodeCollaterals(', section_end: ');', pattern: '\\{(\\d+|INT_MAX), (\\d+) \\* COIN\\}', height: 'supply' },
  FXTC: { repo: 'fxtc/fxtc', file: 'src/chainparams.cpp', rule: 'fxtc', patterns: { min: 'consensus\\.nMasternodeCollateralMinimum = (\\d+);', max: 'consensus\\.nMasternodeCollateralMaximum = (\\d+);', period: 'consensus\\.nMasternodePaymentsIncreasePeriod = (\\d+) \\* (\\d+);' }, height: 'supply' },
  SMT: { repo: 'SmartiesCoin/Smartiecoin', file: 'src/evo/dmn_types.h', rule: 'tiers', names: ['Regular', 'Evo'], pattern: 'collat_amount = (\\d+) \\* COIN' },
  SWAMP: { repo: 'swampcoin/swamp', file: 'src/masternode.cpp', rule: 'tiers', names: [null], pattern: 'coin\\.out\\.nValue != (\\d+) \\* COIN' },
  VECO: { repo: 'vecopay/veco', file: 'src/evo/providertx.cpp', rule: 'tiers', names: [null], pattern: 'coin\\.out\\.nValue != (\\d+) \\* COIN' },
  YERB: { repo: 'The-Yerbas-Endeavor/yerbas', file: 'src/chainparams.cpp', rule: 'schedule_le', section: 'consensus.nCollaterals = SmartnodeCollaterals(', section_end: ');', pattern: '\\{(\\d+|INT_MAX), (\\d+) \\* COIN\\}', height: 'supply' },
  AGU: { repo: 'AgoutiCoin/agouti', file: 'src/masternode.cpp', rule: 'tiers', names: [null], pattern: 'CTxOut\\((\\d+(?:\\.\\d+)?) \\* COIN, obfuScationPool', add: 0.01 },
  LHC: { repo: 'Lightcoindev/Lightcoin', file: 'src/main.h', rule: 'tiers', names: [null], section: 'inline int64_t GetMasterNodeCollateral', pattern: 'return (\\d+);' },
  NS: { repo: 'NODESTATS-NS/nodestats', file: 'src/masternode.cpp', rule: 'schedule_gt', section: 'CAmount CMasternode::GetMasternodeNodeCollateral', pattern: 'nHeight >\\s*(\\d+)\\) return\\s+(\\d+) \\* COIN', height: 'supply' },
  OMEGA: { repo: 'OmegaBlockchain/omegacoin', file: 'src/evo/dmn_types.h', rule: 'tiers', names: ['Regular', 'Evo'], pattern: 'collat_amount = (\\d+) \\* COIN' },
  CS: { repo: 'MauricioSpagnol/cloudservice', file: 'src/csnode/csnode.h', rule: 'tiers', names: ['Proton', 'Eletron', 'Neutron', 'Foton'], pattern: '#define V1_CSNODE_COLLAT_\\w+\\s+(\\d+)' },
  // SorachanCoin: its masternode code defines no collateral amount, so none is shown
  SORA: { repo: 'FromHDDtoSSD/SorachanCoin-qt', file: 'src/masternode/masternode.h', rule: null },
};

const OUT = path.join(__dirname, '..', 'masternode-collateral.json');
// the module below loads the registry when required: on the very first build there is none yet
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, '{"coins":{}}');
const { extract } = require('../masternode-collateral');

(async () => {
  const coins = {};
  const today = new Date().toISOString();
  for (const symbol of Object.keys(RULES)) {
    const spec = Object.assign({}, RULES[symbol]);
    if (spec.rule) {
      const r = await fetch(`https://raw.githubusercontent.com/${spec.repo}/HEAD/${spec.file}`);
      if (!r.ok) throw new Error(symbol + ': source status ' + r.status);
      spec.value = extract(spec, await r.text());
      spec.verified_at = today;
      console.log(symbol.padEnd(7), JSON.stringify(spec.value));
    } else {
      spec.value = null;
      console.log(symbol.padEnd(7), '(no collateral in the code)');
    }
    coins[symbol] = spec;
  }
  fs.writeFileSync(OUT, JSON.stringify({ _comment: 'Masternode collateral rules read from each coin\'s official source code (see masternode-collateral.js). Built by tools/build-collateral-registry.js; "value" is what the code said when verified.', coins }, null, 1));
  console.log('written', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
