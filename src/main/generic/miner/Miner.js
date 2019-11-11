/**
 * @deprecated
 */
class Miner extends Observable {
    /**
     * @param {object} nativeMiner
     * @param {BaseChain} blockchain
     * @param {Accounts} accounts
     * @param {Mempool} mempool
     * @param {Time} time
     * @param {Address} minerAddress
     * @param {Uint8Array} [extraData=new Uint8Array(0)]
     *
     * @listens Mempool#transaction-added
     * @listens Mempool#transaction-ready
     */
    constructor(nativeMiner, blockchain, accounts, mempool, time, minerAddress, extraData = new Uint8Array(0)) {
        super();
        /** @type {BaseChain} */
        this._blockchain = blockchain;
        /** @type {Accounts} */
        this._accounts = accounts;
        /** @type {Mempool} */
        this._mempool = mempool;
        /** @type {Time} */
        this._time = time;
        /**
         * @protected
         * @type {BlockProducer}
         */
        this._producer = new BlockProducer(blockchain, accounts, mempool, time);
        /** @type {Address} */
        this._address = minerAddress;
        /** @type {Uint8Array} */
        this._extraData = extraData;

        /**
         * Number of hashes computed since the last hashrate update.
         * @type {number}
         * @private
         */
        this._hashCount = 0;

        /**
         * Timestamp of the last hashrate update.
         * @type {number}
         * @private
         */
        this._lastHashrate = 0;

        /**
         * Hashrate computation interval handle.
         * @private
         */
        this._hashrateWorker = null;

        /**
         * The current hashrate of this miner.
         * @type {number}
         * @private
         */
        this._hashrate = 0;

        /**
         * The last hash counts used in the moving average.
         * @type {Array.<number>}
         * @private
         */
        this._lastHashCounts = [];

        /**
         * The total hashCount used in the current moving average.
         * @type {number}
         * @private
         */
        this._totalHashCount = 0;

        /**
         * The time elapsed for the last measurements used in the moving average.
         * @type {Array.<number>}
         * @private
         */
        this._lastElapsed = [];

        /**
         * The total time elapsed used in the current moving average.
         * @type {number}
         * @private
         */
        this._totalElapsed = 0;

        /**
         * The native miner instance
         */
        this._nativeMiner = nativeMiner;

        /**
         * Flag indicating that the mempool has changed since we started mining the current block.
         * @type {boolean}
         * @private
         */
        this._mempoolChanged = false;

        /** @type {boolean} */
        this._restarting = false;

        /** @type {number} */
        this._lastRestart = 0;

        /** @type {boolean} */
        this._submittingBlock = false;

        /** @type {number} */
        this._shareCompact = 0;

        /** @type {boolean} */
        this._shareCompactSet = false;

        /** @type {number} */
        this._numBlocksMined = 0;
        /** @type {number} */
        this._numShares = 0;
        /** @type {number} */
        this._numErrors = 0;

        /** @type {boolean} */
        this._activeConfigChanges = false;
        /** @type {boolean} */
        this._pendingConfigChanges = false;

        if (this._mempool) {
            // Listen to changes in the mempool which evicts invalid transactions
            // after every blockchain head change and then fires 'transactions-ready'
            // when the eviction process finishes. Restart work on the next block
            // with fresh transactions when this fires.
            this._mempool.on('transactions-ready', () => this._startWork());

            // Immediately start processing transactions when they come in.
            this._mempool.on('transaction-added', () => this._mempoolChanged = true);
        }
    }

    startWork() {
        if (this.working) {
            return;
        }

        // Initialize hashrate computation.
        this._hashCount = 0;
        this._lastElapsed = [];
        this._lastHashCounts = [];
        this._totalHashCount = 0;
        this._totalElapsed = 0;
        this._lastHashrate = Date.now();
        this._hashrateWorker = setInterval(() => this._updateHashrate(), 1000);
        this._retry = 0;

        // Tell listeners that we've started working.
        this.fire('start', this);

        // Kick off the mining process.
        this._startWork().catch(Log.w.tag(Miner));
    }

    async _startWork() {
        // XXX Needed as long as we cannot unregister from transactions-ready events.
        if (!this.working || this._restarting) {
            return;
        }
        try {
            this._lastRestart = Date.now();
            this._restarting = true;
            this._mempoolChanged = false;

            // Construct next block.
            this._retry = 0;
            const block = await this.getNextBlock();
            if (block === null) {
                this._stopWork();
                return;
            }

            if (block.isFull()) {
                Log.d(Miner, `Starting work on block #${block.header.height} / ${block.minerAddr.toUserFriendlyAddress()} / ${BufferUtils.toBase64(block.body.extraData)} with ${block.transactionCount} transactions (${this._hashrate} H/s)`);
            } else {
                Log.d(Miner, `Starting work on block #${block.header.height} from pool (${this._hashrate} H/s)`);
            }

            this._nativeMiner.setShareCompact(this._shareCompactSet ? this._shareCompact : block.nBits);

            this._nativeMiner.startMiningOnBlock(block.header, async obj => {
                const { nonce, noncesPerRun } = obj;
                if (nonce > 0) {
                    const blockHeader = block.header.serialize();
                    blockHeader.writePos -= 4;
                    blockHeader.writeUint32(nonce);
                    const hash = await (await CryptoWorker.getInstanceAsync()).computeArgon2d(blockHeader);
                    this.onWorkerShare({ hash: new Hash(hash), nonce, block, noncesPerRun });
                } else {
                    this.onWorkerShare({ nonce, noncesPerRun });
                }
            });

        } catch (e) {
            Log.e(Miner, e);
            Log.w(Miner, 'Failed to start work, retrying in 100ms');
            this._stopWork();
            setTimeout(() => this.startWork(), 100);
        } finally {
            this._restarting = false;
        }
    }

    /**
     * @param {{hash: Hash, nonce: number, block: Block, noncesPerRun: number}} obj
     */
    async onWorkerShare(obj) {
        this._hashCount += obj.noncesPerRun;
        if (obj.block && obj.block.prevHash.equals(this._blockchain.headHash)) {
            Log.d(Miner, () => `Received share: ${obj.nonce} / ${obj.hash.toHex()}`);
            if (!this._submittingBlock) {
                obj.block.header.nonce = obj.nonce;

                this._numShares++;
                let blockValid = false;
                if (obj.block.isFull() && BlockUtils.isProofOfWork(obj.hash, obj.block.target)) {
                    this._submittingBlock = true;
                    if (await obj.block.header.verifyProofOfWork()) {
                        this._numBlocksMined++;
                        blockValid = true;

                        // Tell listeners that we've mined a block.
                        this.fire('block-mined', obj.block, this);

                        // Push block into blockchain.
                        if ((await this._blockchain.pushBlock(obj.block)) < 0) {
                            this._submittingBlock = false;
                            this._startWork().catch(Log.w.tag(Miner));
                            return;
                        } else {
                            this._submittingBlock = false;
                        }
                    } else {
                        this._numErrors++;
                        Log.d(Miner, `Ignoring invalid share: ${await obj.block.header.pow()}`);
                    }
                }

                this.fire('share', obj.block, blockValid, this);
            }
        }
        if (this._mempoolChanged && this._lastRestart + Miner.MIN_TIME_ON_BLOCK < Date.now()) {
            this._startWork().catch(Log.w.tag(Miner));
        }
    }

    /**
     * @param {Address} [address]
     * @param {Uint8Array} [extraData]
     * @return {Promise.<Block>}
     */
    async getNextBlock(address = this._address, extraData = this._extraData) {
        this._retry++;
        try {
            return this._producer.getNextBlock(address, extraData);
        } catch (e) {
            // Retry up to three times.
            if (this._retry <= 3) return this.getNextBlock(address, extraData);
            throw e;
        }
    }

    /**
     * @fires Miner#stop
     */
    stopWork() {
        this._stopWork();
    }

    /**
     * @fires Miner#stop
     * @private
     */
    _stopWork() {
        // TODO unregister from blockchain head-changed events.
        if (!this.working) {
            return;
        }

        clearInterval(this._hashrateWorker);
        this._hashrateWorker = null;
        this._hashrate = 0;
        this._lastElapsed = [];
        this._lastHashCounts = [];
        this._totalHashCount = 0;
        this._totalElapsed = 0;

        // Tell listeners that we've stopped working.
        this._nativeMiner.stop();
        this.fire('stop', this);

        Log.d(Miner, 'Stopped work');
    }

    /**
     * @fires Miner#hashrate-changed
     * @private
     */
    _updateHashrate() {
        const elapsed = (Date.now() - this._lastHashrate) / 1000;
        const hashCount = this._hashCount;
        // Enable next measurement.
        this._hashCount = 0;
        this._lastHashrate = Date.now();

        // Update stored information on moving average.
        this._lastElapsed.push(elapsed);
        this._lastHashCounts.push(hashCount);
        this._totalElapsed += elapsed;
        this._totalHashCount += hashCount;

        if (this._lastElapsed.length > Miner.MOVING_AVERAGE_MAX_SIZE) {
            const oldestElapsed = this._lastElapsed.shift();
            const oldestHashCount = this._lastHashCounts.shift();
            this._totalElapsed -= oldestElapsed;
            this._totalHashCount -= oldestHashCount;
        }

        this._hashrate = Math.round(this._totalHashCount / this._totalElapsed);

        // Tell listeners about our new hashrate.
        this.fire('hashrate-changed', this._hashrate, this);
    }

    startConfigChanges() {
        this._activeConfigChanges = true;
        this._pendingConfigChanges = false;
    }

    finishConfigChanges() {
        if (this._pendingConfigChanges) {
            this._startWork().catch(Log.w.tag(Miner));
        }
        this._activeConfigChanges = false;
    }

    /** @type {Address} */
    get address() {
        return this._address;
    }

    /** @type {Address} */
    set address(addr) {
        if (addr && !addr.equals(this._address)) {
            this._address = addr;
            if (!this._activeConfigChanges) {
                this._startWork().catch(Log.w.tag(Miner));
            } else {
                this._pendingConfigChanges = true;
            }
        }
    }

    /** @type {boolean} */
    get working() {
        return !!this._hashrateWorker;
    }

    /** @type {number} */
    get hashrate() {
        return this._hashrate;
    }

    /** @type {Uint8Array} */
    get extraData() {
        return this._extraData;
    }

    /** @type {Uint8Array} */
    set extraData(extra) {
        if (!BufferUtils.equals(extra, this._extraData)) {
            this._extraData = extra;
            if (!this._activeConfigChanges) {
                this._startWork().catch(Log.w.tag(Miner));
            } else {
                this._pendingConfigChanges = true;
            }
        }
    }

    get shareCompact() {
        if (!this._shareCompactSet) {
            return undefined;
        } else {
            return this._shareCompact;
        }
    }

    /** @type {number} */
    set shareCompact(targetCompact) {
        if (!targetCompact) {
            this._shareCompactSet = false;
        } else {
            this._shareCompact = targetCompact;
            this._shareCompactSet = true;
        }
    }

    /** @type {number} */
    get numBlocksMined() {
        return this._numBlocksMined;
    }

    /** @type {number} */
    get numShares() {
        return this._numShares;
    }

    /** @type {number} */
    get numErrors() {
        return this._numErrors;
    }

    /** @type {number} */
    set numErrors(errors) {
        this._numErrors = errors;
    }

}

Miner.MIN_TIME_ON_BLOCK = 10000;
Miner.MOVING_AVERAGE_MAX_SIZE = 10;
Class.register(Miner);
