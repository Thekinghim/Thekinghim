/**
 * Delade typer (JSDoc). Ingen byggkedja — Node kör källkoden direkt.
 *
 * @typedef {Object} TokenMeta
 *   Statisk on-chain-metadata som hämtas en gång vid upptäckt.
 * @property {string} address
 * @property {string} symbol
 * @property {'solana'|'evm'} chain
 * @property {number} createdAt          Unix ms för pool-skapandet.
 * @property {boolean} mintAuthorityActive   Kan någon prägla mer supply?
 * @property {boolean} freezeAuthorityActive Kan någon frysa din wallet?
 * @property {boolean} metadataMutable       Kan namn/bild bytas efter listning?
 * @property {boolean} upgradeableContract   Proxy med admin = kod kan bytas ut.
 * @property {number} lpLockedPct        Andel LP bränd eller låst, 0–100.
 * @property {number} lpUsd              Likviditet i USD.
 * @property {number} buyTaxBps
 * @property {number} sellTaxBps
 * @property {boolean} sellSimulationOk  Gick en simulerad sälj igenom?
 * @property {number} topHolderPct       Topp 10 exkl. LP och burn-adress, 0–100.
 * @property {number} devHoldingPct      Deployerns andel, 0–100.
 * @property {number} bundledLaunchPct   Andel supply köpt i samma block som listningen.
 * @property {string} deployer
 * @property {boolean} deployerFlagged   Deployern finns i vår rug-historik.
 *
 * @typedef {Object} Trade
 * @property {string} token
 * @property {number} ts
 * @property {'buy'|'sell'} side
 * @property {number} amountUsd
 * @property {number} priceUsd
 * @property {string} wallet
 * @property {number} walletAgeHours  Hur gammal walleten är. Färska = ofta deployerns egna.
 * @property {boolean} smartMoney     Walleten finns på vår kuraterade PnL-lista.
 *
 * @typedef {Object} GateResult
 * @property {string} id
 * @property {boolean} passed
 * @property {string} reason
 *
 * @typedef {Object} SafetyVerdict
 * @property {boolean} passed          Alla hårda grindar klarade.
 * @property {GateResult[]} gates
 * @property {number} riskScore        0–100, högre = värre.
 * @property {{id: string, points: number, detail: string}[]} riskFactors
 *
 * @typedef {Object} MomentumVerdict
 * @property {number} score            0–100.
 * @property {{id: string, points: number, detail: string}[]} factors
 * @property {Object} metrics
 *
 * @typedef {Object} Candidate
 * @property {TokenMeta} meta
 * @property {SafetyVerdict} safety
 * @property {MomentumVerdict} momentum
 * @property {number} ageMinutes
 * @property {number} priceUsd
 * @property {boolean} alerted
 * @property {number} updatedAt
 */
export {};
