const { Client } = require('pg');

const CONNECTION = 'postgresql://postgres.ewciynnuevuzbcrwcjut:ahmedmo7sonpiew@aws-1-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require';

// Customer profiles with realistic loyalty data
const customers = [
  {
    id: 1, name: 'ismail', token: '9a97aa0f7ad8536c82bd3be7',
    currentPoints: 442, lifetimePoints: 520, tierId: 2, // Gold (300+)
    assignedAt: '2026-07-01T14:22:25.992Z',
    monthlySpent: 165, monthlyPointsEarned: 65,
  },
  {
    id: 2, name: 'ahmed', token: 'ed7f7b61674caa866fcbb631',
    currentPoints: 990.7, lifetimePoints: 1520, tierId: 3, // VIP (500+)
    assignedAt: '2026-07-02T08:40:07.103Z',
    monthlySpent: 200, monthlyPointsEarned: 85,
  },
  {
    id: 3, name: 'hamed', token: 'cb2cc2d8bc24570db848b968',
    currentPoints: 58.2, lifetimePoints: 120, tierId: 1, // Silver (100+)
    assignedAt: '2026-08-05T14:54:30.683Z',
    monthlySpent: 50, monthlyPointsEarned: 50,
  },
  {
    id: 4, name: 'khadija', token: 'a8d84b97aa58c4cadc6fcd13',
    currentPoints: 40, lifetimePoints: 85, tierId: null, // No tier yet
    assignedAt: '2026-08-06T17:46:38.786Z',
    monthlySpent: 50, monthlyPointsEarned: 45,
  },
  {
    id: 5, name: 'imed', token: '156613a44401606449478990',
    currentPoints: 30, lifetimePoints: 55, tierId: null,
    assignedAt: '2026-08-06T17:48:20.296Z',
    monthlySpent: 30, monthlyPointsEarned: 30,
  },
  {
    id: 6, name: 'yessmine', token: '530af49f5b698e33fdd9ac40',
    currentPoints: 35, lifetimePoints: 70, tierId: null,
    assignedAt: '2026-08-06T17:52:01.408Z',
    monthlySpent: 35, monthlyPointsEarned: 35,
  },
  {
    id: 7, name: 'baya', token: '96be6ca24118d26cc24c825a',
    currentPoints: 29, lifetimePoints: 65, tierId: null,
    assignedAt: '2026-08-06T17:55:18.522Z',
    monthlySpent: 35, monthlyPointsEarned: 35,
  },
  {
    id: 8, name: 'meher', token: 'db1d536f7a8b146dffa387ec',
    currentPoints: 37.5, lifetimePoints: 90, tierId: null,
    assignedAt: '2026-08-06T17:56:58.952Z',
    monthlySpent: 50, monthlyPointsEarned: 52,
  },
  {
    id: 9, name: 'ayemen', token: '0ed783a6009847d21c693498',
    currentPoints: 74.4, lifetimePoints: 150, tierId: 1, // Silver
    assignedAt: '2026-08-06T17:58:00.643Z',
    monthlySpent: 80, monthlyPointsEarned: 75,
  },
  {
    id: 10, name: 'sarra', token: '1ef4ce1f74d917118bb06b46',
    currentPoints: 20, lifetimePoints: 45, tierId: null,
    assignedAt: '2026-08-06T17:59:54.891Z',
    monthlySpent: 30, monthlyPointsEarned: 20,
  },
];

// Transaction history definitions per customer
// type: recharge | deduction | bonus | reward
// points: positive = earned, negative = spent
// The balance_before/balance_after must chain correctly
function buildTransactions(c) {
  const txs = [];
  let balance = 0;
  const now = new Date();

  if (c.id === 1) { // ismail - Gold customer, active since July
    // July recharges
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-07-02T10:15:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-07-08T14:30:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -25, amount: null, desc: 'Paiement commande table 5', date: '2026-07-10T19:20:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-07-15T11:45:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -18.5, amount: null, desc: 'Paiement commande table 3', date: '2026-07-18T20:10:00Z', by: null });
    txs.push({ type: 'bonus', points: 10, amount: null, desc: 'Bonus fidélité Silver atteint', date: '2026-07-20T12:00:00Z', by: 'Système' });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-07-25T16:00:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -32, amount: null, desc: 'Paiement commande table 8', date: '2026-07-28T21:30:00Z', by: null });
    // August recharges
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-01T10:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-05T15:20:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -28.5, amount: null, desc: 'Paiement commande table 2', date: '2026-08-08T19:45:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-12T11:30:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -21, amount: null, desc: 'Paiement commande table 6', date: '2026-08-15T20:00:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-18T14:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -15.3, amount: null, desc: 'Paiement commande table 4', date: '2026-08-20T18:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-22T10:15:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -12, amount: null, desc: 'Paiement commande table 1', date: '2026-08-24T19:00:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-26T16:45:00Z', by: 'Nadia' });
  }

  if (c.id === 2) { // ahmed - VIP customer, heavy user
    txs.push({ type: 'recharge', points: 115, amount: 100, desc: 'Recharge forfait Premium 100 DT', date: '2026-07-03T09:00:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -45, amount: null, desc: 'Paiement commande table 10', date: '2026-07-05T20:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-07-08T11:15:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 250, amount: 200, desc: 'Recharge forfait Ultimate 200 DT', date: '2026-07-12T14:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -62, amount: null, desc: 'Paiement commande table 7', date: '2026-07-15T21:00:00Z', by: null });
    txs.push({ type: 'bonus', points: 15, amount: null, desc: 'Bonus fidélité Gold atteint', date: '2026-07-16T12:00:00Z', by: 'Système' });
    txs.push({ type: 'recharge', points: 115, amount: 100, desc: 'Recharge forfait Premium 100 DT', date: '2026-07-20T10:30:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -38, amount: null, desc: 'Paiement commande table 3', date: '2026-07-23T19:15:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-07-27T15:45:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -55, amount: null, desc: 'Paiement commande table 12', date: '2026-07-30T20:45:00Z', by: null });
    // August
    txs.push({ type: 'recharge', points: 250, amount: 200, desc: 'Recharge forfait Ultimate 200 DT', date: '2026-08-02T09:30:00Z', by: 'Karim' });
    txs.push({ type: 'bonus', points: 20, amount: null, desc: 'Bonus fidélité VIP atteint', date: '2026-08-03T12:00:00Z', by: 'Système' });
    txs.push({ type: 'deduction', points: -72, amount: null, desc: 'Paiement commande table 5', date: '2026-08-05T21:15:00Z', by: null });
    txs.push({ type: 'recharge', points: 115, amount: 100, desc: 'Recharge forfait Premium 100 DT', date: '2026-08-09T11:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -48, amount: null, desc: 'Paiement commande table 9', date: '2026-08-12T19:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-16T14:15:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -35, amount: null, desc: 'Paiement commande table 2', date: '2026-08-19T20:00:00Z', by: null });
    txs.push({ type: 'recharge', points: 115, amount: 100, desc: 'Recharge forfait Premium 100 DT', date: '2026-08-22T10:45:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -42.3, amount: null, desc: 'Paiement commande table 6', date: '2026-08-25T18:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-27T12:00:00Z', by: 'Karim' });
  }

  if (c.id === 3) { // hamed - Silver, new customer
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-05T15:00:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -18, amount: null, desc: 'Paiement commande table 3', date: '2026-08-07T19:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-10T11:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -8.8, amount: null, desc: 'Paiement commande table 1', date: '2026-08-14T20:15:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-18T14:30:00Z', by: 'Karim' });
  }

  if (c.id === 4) { // khadija - No tier yet
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-12T10:30:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -20, amount: null, desc: 'Paiement commande table 4', date: '2026-08-18T19:00:00Z', by: null });
  }

  if (c.id === 5) { // imed
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-15T11:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -30, amount: null, desc: 'Paiement commande table 7', date: '2026-08-20T20:30:00Z', by: null });
  }

  if (c.id === 6) { // yessmine
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-14T15:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -25, amount: null, desc: 'Paiement commande table 2', date: '2026-08-21T19:45:00Z', by: null });
  }

  if (c.id === 7) { // baya
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-16T10:30:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -31, amount: null, desc: 'Paiement commande table 5', date: '2026-08-22T20:00:00Z', by: null });
  }

  if (c.id === 8) { // meher
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-11T14:00:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -47.5, amount: null, desc: 'Paiement commande table 8', date: '2026-08-17T21:00:00Z', by: null });
  }

  if (c.id === 9) { // ayemen - Silver
    txs.push({ type: 'recharge', points: 55, amount: 50, desc: 'Recharge forfait Popular 50 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -22, amount: null, desc: 'Paiement commande table 3', date: '2026-08-09T19:30:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-13T11:15:00Z', by: 'Nadia' });
    txs.push({ type: 'deduction', points: -15, amount: null, desc: 'Paiement commande table 6', date: '2026-08-17T20:00:00Z', by: null });
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-21T14:30:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -23.6, amount: null, desc: 'Paiement commande table 1', date: '2026-08-25T19:15:00Z', by: null });
  }

  if (c.id === 10) { // sarra
    txs.push({ type: 'recharge', points: 30, amount: 30, desc: 'Recharge forfait Standard 30 DT', date: '2026-08-06T18:00:00Z', by: 'Karim' });
    txs.push({ type: 'deduction', points: -10, amount: null, desc: 'Paiement commande table 4', date: '2026-08-15T19:00:00Z', by: null });
  }

  // Compute balances
  let running = 0;
  for (const tx of txs) {
    tx.balanceBefore = running;
    running += tx.points;
    tx.balanceAfter = running;
  }

  return txs;
}

// Rewards for customers who earned them
const rewardDefs = [
  { id: 1, name: 'Free Petit Dejeuner', requiredPoints: 30, rewardType: 'free_item' },
  { id: 2, name: '20% OFF', requiredPoints: 100, rewardType: 'discount', discountPercent: 20 },
  { id: 3, name: '30% OFF', requiredPoints: 200, rewardType: 'discount', discountPercent: 30 },
  { id: 4, name: 'Mystery Reward', requiredPoints: 150, rewardType: 'mystery' },
];

function buildRewards(c) {
  const rewards = [];
  const lp = c.lifetimePoints;

  // Customer earns rewards as they hit thresholds
  if (lp >= 30) {
    rewards.push({ rewardId: 1, mysteryResult: null, isRedeemed: true, earnedAt: addDays(c.assignedAt, 3), redeemedAt: addDays(c.assignedAt, 10) });
  }
  if (lp >= 100) {
    rewards.push({ rewardId: 2, mysteryResult: null, isRedeemed: false, earnedAt: addDays(c.assignedAt, 14), redeemedAt: null });
  }
  if (lp >= 150 && c.id !== 4) { // Mystery for customers with 150+
    const mysteryOptions = ['Free Petit Dejeuner', 'Free Coffee', '10% OFF', '20% OFF', 'Free Dessert'];
    const mystery = mysteryOptions[c.id % mysteryOptions.length];
    rewards.push({ rewardId: 4, mysteryResult: mystery, isRedeemed: false, earnedAt: addDays(c.assignedAt, 20), redeemedAt: null });
  }
  if (lp >= 200 && (c.id === 1 || c.id === 2)) {
    rewards.push({ rewardId: 3, mysteryResult: null, isRedeemed: c.id === 2, earnedAt: addDays(c.assignedAt, 25), redeemedAt: c.id === 2 ? addDays(c.assignedAt, 35) : null });
  }
  // Extra rewards for heavy users
  if (c.id === 1) {
    rewards.push({ rewardId: 1, mysteryResult: null, isRedeemed: true, earnedAt: addDays(c.assignedAt, 30), redeemedAt: addDays(c.assignedAt, 38) });
  }
  if (c.id === 2) {
    rewards.push({ rewardId: 1, mysteryResult: null, isRedeemed: true, earnedAt: addDays(c.assignedAt, 20), redeemedAt: addDays(c.assignedAt, 28) });
    rewards.push({ rewardId: 2, mysteryResult: null, isRedeemed: true, earnedAt: addDays(c.assignedAt, 40), redeemedAt: addDays(c.assignedAt, 50) });
  }

  return rewards;
}

function addDays(isoStr, days) {
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function main() {
  const client = new Client({ connectionString: CONNECTION });
  await client.connect();
  console.log('Connected to database');

  try {
    // 1. Update qr_code: set tier_id and lifetime_points
    console.log('\n--- Updating qr_code tier_id and lifetime_points ---');
    for (const c of customers) {
      await client.query(
        'UPDATE qr_code SET tier_id = $1, lifetime_points = $2, updated_at = NOW() WHERE id = $3',
        [c.tierId, c.lifetimePoints, c.id]
      );
      console.log(`  ${c.name}: tier_id=${c.tierId}, lifetime_points=${c.lifetimePoints}`);
    }

    // 2. Clear existing loyalty data (in case of re-seed)
    console.log('\n--- Clearing existing loyalty data ---');
    await client.query('DELETE FROM customer_rewards WHERE qr_code_id <= 10');
    await client.query('DELETE FROM loyalty_transactions WHERE qr_code_id <= 10');
    await client.query('DELETE FROM customer_challenges WHERE qr_code_id <= 10');
    await client.query('DELETE FROM point_today WHERE qr_code_id <= 10');
    console.log('  Cleared old data');

    // 3. Insert loyalty_transactions
    console.log('\n--- Inserting loyalty_transactions ---');
    let totalTxs = 0;
    for (const c of customers) {
      const txs = buildTransactions(c);
      for (const tx of txs) {
        await client.query(
          `INSERT INTO loyalty_transactions (qr_code_id, type, points, balance_before, balance_after, amount, payment_method, description, reference_id, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            c.id,
            tx.type,
            tx.points,
            tx.balanceBefore,
            tx.balanceAfter,
            tx.amount,
            tx.type === 'recharge' ? 'cash' : null,
            tx.desc,
            null,
            tx.by,
            tx.date,
          ]
        );
        totalTxs++;
      }
      console.log(`  ${c.name}: ${txs.length} transactions`);
    }
    console.log(`  Total: ${totalTxs} transactions`);

    // 4. Insert customer_rewards
    console.log('\n--- Inserting customer_rewards ---');
    let totalRewards = 0;
    for (const c of customers) {
      const rewards = buildRewards(c);
      for (const r of rewards) {
        await client.query(
          `INSERT INTO customer_rewards (qr_code_id, reward_id, mystery_result, is_redeemed, earned_at, redeemed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [c.id, r.rewardId, r.mysteryResult, r.isRedeemed, r.earnedAt, r.redeemedAt]
        );
        totalRewards++;
      }
      console.log(`  ${c.name}: ${rewards.length} rewards`);
    }
    console.log(`  Total: ${totalRewards} rewards`);

    // 5. Insert point_today records for recent recharges (last 7 days)
    console.log('\n--- Inserting point_today records ---');
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    let totalPt = 0;
    for (const c of customers) {
      const txs = buildTransactions(c);
      const recentRecharges = txs.filter(tx => tx.type === 'recharge' && new Date(tx.date) >= sevenDaysAgo);
      for (const tx of recentRecharges) {
        const dateStr = tx.date.slice(0, 10);
        await client.query(
          `INSERT INTO point_today (qr_code_id, points, cash_amount, date, added_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [c.id, tx.points, tx.amount, dateStr, tx.by, tx.date]
        );
        totalPt++;
      }
      if (recentRecharges.length > 0) {
        console.log(`  ${c.name}: ${recentRecharges.length} point_today records`);
      }
    }
    console.log(`  Total: ${totalPt} point_today records`);

    console.log('\n=== SEED COMPLETE ===');
    console.log(`Updated ${customers.length} qr_code cards`);
    console.log(`Inserted ${totalTxs} transactions`);
    console.log(`Inserted ${totalRewards} rewards`);
    console.log(`Inserted ${totalPt} point_today records`);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await client.end();
  }
}

main();
