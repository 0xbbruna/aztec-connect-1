import { GrumpkinAddress } from '@aztec/barretenberg/address';
import { Block, BlockServerResponse, GetBlocksServerResponse } from '@aztec/barretenberg/block_source';
import { ProofData } from '@aztec/barretenberg/client_proofs';
import {
  PendingTxServerResponse,
  rollupProviderStatusToJson,
  RuntimeConfig,
  TxPostData,
  TxServerResponse,
} from '@aztec/barretenberg/rollup_provider';
import cors from '@koa/cors';
import { ApolloServer } from 'apollo-server-koa';
import graphqlPlayground from 'graphql-playground-middleware-koa';
import Koa, { Context, DefaultState } from 'koa';
import compress from 'koa-compress';
import Router from 'koa-router';
import { PromiseReadable } from 'promise-readable';
import requestIp from 'request-ip';
import { buildSchemaSync } from 'type-graphql';
import { Container } from 'typedi';
import { TxDao } from './entity/tx';
import { Metrics } from './metrics';
import { JoinSplitTxResolver, RollupResolver, ServerStatusResolver, TxResolver } from './resolver';
import { Server } from './server';
import { Tx } from './tx_receiver';

const toBlockResponse = (block: Block): BlockServerResponse => ({
  ...block,
  txHash: block.txHash.toString(),
  rollupProofData: block.rollupProofData.toString('hex'),
  offchainTxData: block.offchainTxData.map(d => d.toString('hex')),
  interactionResult: block.interactionResult.map(r => r.toBuffer().toString('hex')),
  created: block.created.toISOString(),
  gasPrice: block.gasPrice.toString(),
});

const toTxResponse = ({ proofData, offchainTxData }: TxDao): TxServerResponse => ({
  proofData: proofData.toString('hex'),
  offchainData: offchainTxData.toString('hex'),
});

const bufferFromHex = (hexStr: string) => Buffer.from(hexStr.replace(/^0x/i, ''), 'hex');

const fromTxPostData = (data: TxPostData): Tx => ({
  proof: new ProofData(bufferFromHex(data.proofData)),
  offchainTxData: bufferFromHex(data.offchainTxData),
  depositSignature: data.depositSignature ? bufferFromHex(data.depositSignature) : undefined,
  parentTx: data.parentProof ? fromTxPostData(data.parentProof) : undefined,
});

export function appFactory(server: Server, prefix: string, metrics: Metrics, serverAuthToken: string) {
  const router = new Router<DefaultState, Context>({ prefix });

  const validateAuth = async (ctx: Koa.Context, next: () => Promise<void>) => {
    const authToken = ctx.request.headers['server-auth-token'];

    if (authToken !== serverAuthToken) {
      ctx.status = 401;
      ctx.body = { error: 'Invalid server auth token.' };
    } else {
      await next();
    }
  };

  const recordMetric = async (ctx: Koa.Context, next: () => Promise<void>) => {
    metrics.httpEndpoint(ctx.URL.pathname);
    await next();
  };

  const checkReady = async (ctx: Koa.Context, next: () => Promise<void>) => {
    if (!server.isReady()) {
      ctx.status = 503;
      ctx.body = { error: 'Server not ready. Try again later.' };
    } else {
      await next();
    }
  };

  const exceptionHandler = async (ctx: Koa.Context, next: () => Promise<void>) => {
    try {
      await next();
    } catch (err: any) {
      console.log(err);
      ctx.status = 400;
      ctx.body = { error: err.message };
    }
  };

  router.get('/', recordMetric, async (ctx: Koa.Context) => {
    ctx.body = {
      serviceName: 'falafel',
      isReady: server.isReady(),
    };
    ctx.status = 200;
  });

  router.post('/tx', recordMetric, checkReady, async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const postData = JSON.parse((await stream.readAll()) as string);
    const tx = fromTxPostData(postData);
    const txId = await server.receiveTx(tx);
    const response = {
      txHash: txId.toString('hex'),
    };
    ctx.body = response;
    ctx.status = 200;
  });

  router.post('/client-log', async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const log = JSON.parse((await stream.readAll()) as string);
    const clientIp = requestIp.getClientIp(ctx.request);
    const userAgent = ctx.request.header['user-agent'];
    const data = {
      ...log,
      clientIp,
      userAgent,
    };
    console.log(`Client log for: ${JSON.stringify(data)}`);
    ctx.status = 200;
  });

  router.get('/get-blocks', recordMetric, async (ctx: Koa.Context) => {
    const blocks = await server.getBlocks(+ctx.query.from);
    const response: GetBlocksServerResponse = {
      latestRollupId: await server.getLatestRollupId(),
      blocks: blocks.map(toBlockResponse),
    };
    ctx.body = response;
    ctx.status = 200;
  });

  router.get('/remove-data', recordMetric, validateAuth, async (ctx: Koa.Context) => {
    await server.removeData();
    ctx.status = 200;
  });

  router.get('/reset', recordMetric, validateAuth, async (ctx: Koa.Context) => {
    await server.resetPipline();
    ctx.status = 200;
  });

  router.patch('/runtime-config', recordMetric, validateAuth, async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const runtimeConfig: Partial<RuntimeConfig> = JSON.parse((await stream.readAll()) as string);
    server.setRuntimeConfig(runtimeConfig);
    ctx.status = 200;
  });

  router.get('/flush', recordMetric, validateAuth, async (ctx: Koa.Context) => {
    server.flushTxs();
    ctx.status = 200;
  });

  router.get('/status', recordMetric, async (ctx: Koa.Context) => {
    const status = await server.getStatus();
    const response = rollupProviderStatusToJson(status);
    ctx.set('content-type', 'application/json');
    ctx.body = response;
    ctx.status = 200;
  });

  router.get('/get-initial-world-state', recordMetric, checkReady, async (ctx: Koa.Context) => {
    const response = await server.getInitialWorldState();
    ctx.body = response.initialAccounts;
    ctx.status = 200;
  });

  router.get('/get-pending-txs', recordMetric, async (ctx: Koa.Context) => {
    const txs = await server.getUnsettledTxs();
    ctx.body = txs
      .map(tx => new ProofData(tx.proofData))
      .map(
        (proof): PendingTxServerResponse => ({
          txId: proof.txId.toString('hex'),
          noteCommitment1: proof.noteCommitment1.toString('hex'),
          noteCommitment2: proof.noteCommitment2.toString('hex'),
        }),
      );
    ctx.status = 200;
  });

  router.get('/get-pending-note-nullifiers', recordMetric, async (ctx: Koa.Context) => {
    const nullifiers = await server.getUnsettledNullifiers();
    ctx.body = nullifiers.map(n => n.toString('hex'));
    ctx.status = 200;
  });

  router.post('/get-latest-account-nonce', recordMetric, async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const data = JSON.parse((await stream.readAll()) as string);
    const accountPubKey = GrumpkinAddress.fromString(data.accountPubKey);
    ctx.body = await server.getLatestAccountNonce(accountPubKey);
    ctx.status = 200;
  });

  router.post('/get-latest-alias-nonce', recordMetric, async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const { alias } = JSON.parse((await stream.readAll()) as string);
    ctx.body = await server.getLatestAliasNonce(alias);
    ctx.status = 200;
  });

  router.post('/get-account-id', recordMetric, async (ctx: Koa.Context) => {
    const stream = new PromiseReadable(ctx.req);
    const { alias, nonce } = JSON.parse((await stream.readAll()) as string);
    const accountId = await server.getAccountId(alias, nonce ? +nonce : undefined);
    ctx.body = accountId?.toString() || '';
    ctx.status = 200;
  });

  router.get('/get-unsettled-account-txs', recordMetric, async (ctx: Koa.Context) => {
    const txs = await server.getUnsettledAccountTxs();
    ctx.body = txs.map(toTxResponse);
    ctx.status = 200;
  });

  router.get('/get-unsettled-join-split-txs', recordMetric, async (ctx: Koa.Context) => {
    const txs = await server.getUnsettledJoinSplitTxs();
    ctx.body = txs.map(toTxResponse);
    ctx.status = 200;
  });

  router.get('/metrics', recordMetric, async (ctx: Koa.Context) => {
    ctx.body = await metrics.getMetrics();
    ctx.status = 200;
  });

  router.all('/playground', recordMetric, graphqlPlayground({ endpoint: `${prefix}/graphql` }));

  const app = new Koa();
  app.proxy = true;
  app.use(compress());
  app.use(cors());
  app.use(exceptionHandler);
  app.use(router.routes());
  app.use(router.allowedMethods());

  const schema = buildSchemaSync({
    resolvers: [JoinSplitTxResolver, RollupResolver, TxResolver, ServerStatusResolver],
    container: Container,
  });
  const appServer = new ApolloServer({ schema, introspection: true });
  appServer.applyMiddleware({ app, path: `${prefix}/graphql` });

  return app;
}
