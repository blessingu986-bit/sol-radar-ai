
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Only POST requests are allowed." });
  }

  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "HELIUS_API_KEY is missing from Vercel."
    });
  }

  const { address, limit = 100 } = req.body || {};

  if (typeof address !== "string" || !ADDRESS_RE.test(address.trim())) {
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
    const url = new URL(
      `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(wallet)}/transactions`
    );

    url.searchParams.set("api-key", apiKey);
    url.searchParams.set("limit", String(safeLimit));
    url.searchParams.set("sort-order", "desc");
    url.searchParams.set("token-accounts", "balanceChanged");

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429
          ? "Helius rate limit reached. Please wait and try again."
          : `Helius returned an error (${response.status}).`
      });
    }

    if (!Array.isArray(data)) {
      return res.status(502).json({
        error: "Unexpected response from Helius."
      });
    }

    let incomingSOL = 0;
    let outgoingSOL = 0;
    let tokenTransactions = 0;
    let failedTransactions = 0;

    const activityTypes = {};
    const timeline = [];

    for (const tx of data) {
      const transfers = Array.isArray(tx.nativeTransfers)
        ? tx.nativeTransfers
        : [];

      for (const transfer of transfers) {
        const amount = Number(transfer.amount || 0) / 1e9;

        if (transfer.toUserAccount === wallet) {
          incomingSOL += amount;
        }

        if (transfer.fromUserAccount === wallet) {
          outgoingSOL += amount;
        }
      }

      if (
        Array.isArray(tx.tokenTransfers) &&
        tx.tokenTransfers.length > 0
      ) {
        tokenTransactions++;
      }

      if (tx.transactionError) {
        failedTransactions++;
      }

      const type = tx.type || "UNKNOWN";
      activityTypes[type] = (activityTypes[type] || 0) + 1;

      timeline.push({
        signature: tx.signature || "",
        timestamp: tx.timestamp || null,
        type,
        description: tx.description || "",
        status: tx.transactionError ? "Failed" : "Success"
      });
    }

    const netSOL = incomingSOL - outgoingSOL;

    return res.status(200).json({
      address: wallet,
      count: data.length,

      intelligence: {
        transactionsScanned: data.length,
        incomingSOL: Number(incomingSOL.toFixed(9)),
        outgoingSOL: Number(outgoingSOL.toFixed(9)),
        netSOLTransfers: Number(netSOL.toFixed(9)),
        tokenTransactions,
        failedTransactions,
        successfulTransactions: data.length - failedTransactions,
        activityTypes,
        timeline
      },

      transactions: data
    });

  } catch (error) {
    return res.status(500).json({
      error: "Unable to connect to Helius."
    });
  }
};
