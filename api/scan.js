
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const MAX_CONNECTED_WALLETS = 5;
const CONNECTED_WALLET_LIMIT = 25;

async function fetchWalletTransactions(address, limit, apiKey) {
  const url = new URL(
    `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(address)}/transactions`
  );

  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort-order", "desc");
  url.searchParams.set("token-accounts", "balanceChanged");

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(`Helius error: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (!Array.isArray(data)) {
    throw new Error("Unexpected Helius response.");
  }

  return data;
}

function getWalletConnections(transactions, mainWallet) {
  const connections = new Map();

  function recordConnection(address, direction, amount, signature) {
    if (
      typeof address !== "string" ||
      !ADDRESS_RE.test(address) ||
      address === mainWallet
    ) return;

    if (!connections.has(address)) {
      connections.set(address, {
        address,
        interactions: 0,
        incomingInteractions: 0,
        outgoingInteractions: 0,
        solVolume: 0,
        signatures: new Set()
      });
    }

    const item = connections.get(address);

    item.interactions++;
    item.signatures.add(signature);

    if (direction === "incoming") {
      item.incomingInteractions++;
    } else {
      item.outgoingInteractions++;
    }

    item.solVolume += amount;
  }

  for (const tx of transactions) {
    const signature = tx.signature || "";

    for (const transfer of tx.nativeTransfers || []) {
      const amount = Number(transfer.amount || 0) / 1e9;

      if (transfer.toUserAccount === mainWallet) {
        recordConnection(
          transfer.fromUserAccount,
          "incoming",
          amount,
          signature
        );
      }

      if (transfer.fromUserAccount === mainWallet) {
        recordConnection(
          transfer.toUserAccount,
          "outgoing",
          amount,
          signature
        );
      }
    }

    for (const transfer of tx.tokenTransfers || []) {
      if (transfer.toUserAccount === mainWallet) {
        recordConnection(
          transfer.fromUserAccount,
          "incoming",
          0,
          signature
        );
      }

      if (transfer.fromUserAccount === mainWallet) {
        recordConnection(
          transfer.toUserAccount,
          "outgoing",
          0,
          signature
        );
      }
    }
  }

  return [...connections.values()]
    .map(item => ({
      address: item.address,
      interactions: item.interactions,
      uniqueTransactions: item.signatures.size,
      incomingInteractions: item.incomingInteractions,
      outgoingInteractions: item.outgoingInteractions,
      solVolume: Number(item.solVolume.toFixed(9))
    }))
    .sort((a, b) =>
      b.interactions - a.interactions ||
      b.solVolume - a.solVolume
    )
    .slice(0, MAX_CONNECTED_WALLETS);
}

function analyseWallet(address, transactions) {
  let incomingSOL = 0;
  let outgoingSOL = 0;
  let tokenTransactions = 0;
  let failedTransactions = 0;

  const activityTypes = {};
  const counterparties = new Map();

  for (const tx of transactions) {
    for (const transfer of tx.nativeTransfers || []) {
      const amount = Number(transfer.amount || 0) / 1e9;

      if (transfer.toUserAccount === address) {
        incomingSOL += amount;
        const sender = transfer.fromUserAccount;
        if (sender && sender !== address) {
          counterparties.set(
            sender,
            (counterparties.get(sender) || 0) + 1
          );
        }
      }

      if (transfer.fromUserAccount === address) {
        outgoingSOL += amount;
        const receiver = transfer.toUserAccount;
        if (receiver && receiver !== address) {
          counterparties.set(
            receiver,
            (counterparties.get(receiver) || 0) + 1
          );
        }
      }
    }

    if ((tx.tokenTransfers || []).length > 0) {
      tokenTransactions++;
    }

    if (tx.transactionError) {
      failedTransactions++;
    }

    const type = tx.type || "UNKNOWN";
    activityTypes[type] = (activityTypes[type] || 0) + 1;

    for (const transfer of tx.tokenTransfers || []) {
      for (const other of [
        transfer.fromUserAccount,
        transfer.toUserAccount
      ]) {
        if (other && other !== address) {
          counterparties.set(
            other,
            (counterparties.get(other) || 0) + 1
          );
        }
      }
    }
  }

  const repeatedCounterparties = [...counterparties.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([wallet, interactions]) => ({
      address: wallet,
      interactions
    }));

  return {
    transactionsScanned: transactions.length,
    incomingSOL: Number(incomingSOL.toFixed(9)),
    outgoingSOL: Number(outgoingSOL.toFixed(9)),
    netSOLTransfers: Number((incomingSOL - outgoingSOL).toFixed(9)),
    tokenTransactions,
    failedTransactions,
    successfulTransactions: transactions.length - failedTransactions,
    activityTypes,
    repeatedCounterparties,
    repeatedCounterpartyCount: repeatedCounterparties.length
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Only POST requests are allowed."
    });
  }

  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "HELIUS_API_KEY is missing from Vercel."
    });
  }

  const { address, limit = 100 } = req.body || {};

  if (
    typeof address !== "string" ||
    !ADDRESS_RE.test(address.trim())
  ) {
    return res.status(400).json({
      error: "Please enter a valid Solana public address."
    });
  }

  const wallet = address.trim();

  const safeLimit = Math.min(
    100,
    Math.max(1, Number.parseInt(limit, 10) || 100)
  );

  try {
    // 1. Scan the wallet entered by the user.
    const transactions = await fetchWalletTransactions(
      wallet,
      safeLimit,
      apiKey
    );

    const incomingOutgoing = analyseWallet(wallet, transactions);

    // 2. Discover its connected wallets.
    const connectedWallets = getWalletConnections(
      transactions,
      wallet
    );

    // 3. Automatically investigate the top five connections.
    // Requests are sequential to avoid sending a burst of API calls.
    const investigations = [];

    for (const connection of connectedWallets) {
      try {
        const connectedTransactions = await fetchWalletTransactions(
          connection.address,
          CONNECTED_WALLET_LIMIT,
          apiKey
        );

        investigations.push({
          ...connection,
          status: "analysed",
          intelligence: analyseWallet(
            connection.address,
            connectedTransactions
          )
        });
      } catch (error) {
        investigations.push({
          ...connection,
          status: "unavailable",
          error: error.status === 429
            ? "Helius rate limit reached."
            : "Could not retrieve this wallet's transactions."
        });
      }
    }

    // 4. Identify counterparties shared by multiple investigated wallets.
    const sharedConnections = new Map();

    for (const item of investigations) {
      if (item.status !== "analysed") continue;

      for (const counterparty of item.intelligence.repeatedCounterparties) {
        if (!sharedConnections.has(counterparty.address)) {
          sharedConnections.set(counterparty.address, new Set());
        }

        sharedConnections.get(counterparty.address).add(item.address);
      }
    }

    const possibleClusters = [...sharedConnections.entries()]
      .filter(([, wallets]) => wallets.size >= 2)
      .map(([sharedAddress, wallets]) => ({
        sharedAddress,
        connectedWallets: [...wallets],
        walletCount: wallets.size,
        observation: "Multiple investigated wallets interacted with this address."
      }));

    return res.status(200).json({
      address: wallet,
      count: transactions.length,

      intelligence: {
        ...incomingOutgoing,
        timeline: transactions.map(tx => ({
          signature: tx.signature || "",
          timestamp: tx.timestamp || null,
          type: tx.type || "UNKNOWN",
          description: tx.description || "",
          status: tx.transactionError ? "Failed" : "Success"
        }))
      },

      walletInvestigation: {
        enabled: true,
        walletsDiscovered: connectedWallets.length,
        walletsAnalysed: investigations.filter(
          item => item.status === "analysed"
        ).length,
        transactionLimitPerConnectedWallet: CONNECTED_WALLET_LIMIT,
        connectedWallets: investigations,
        possibleClusters,
        disclaimer:
          "These are transaction-pattern observations, not proof of common ownership, fraud, or wrongdoing. Net SOL transfers are not profit or PnL."
      },

      transactions
    });

  } catch (error) {
    return res.status(
      error.status === 429 ? 429 : 502
    ).json({
      error: error.status === 429
        ? "Helius rate limit reached. Please wait and try again."
        : "Unable to complete the Helius wallet scan."
    });
  }
};
