'use strict';

const store = require('../mysql-store');
const { pickBillingAddressForCheckout } = require('../tax-free-address');

describe('US tax-free billing address selection', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses a US address even when the payment region is PH', async () => {
        const runQuery = vi.spyOn(store, 'runQuery').mockResolvedValue([{
            id: 7,
            line1: '1234 NW Flanders Street',
            city: 'Portland',
            state: 'OR',
            postal_code: '97209',
            country: 'US'
        }]);
        vi.spyOn(store, 'setAppConfigValue').mockResolvedValue(undefined);

        const address = await pickBillingAddressForCheckout('PH', null);

        expect(runQuery).toHaveBeenCalledWith(expect.stringContaining('FROM tax_free_addresses'), ['US']);
        expect(address).toMatchObject({
            id: 7,
            city: 'Portland',
            state: 'Oregon',
            country: 'US'
        });
    });

    it('generates a US fallback when the US pool is empty', async () => {
        vi.spyOn(store, 'runQuery').mockResolvedValue([]);

        const address = await pickBillingAddressForCheckout('PH', null);

        expect(address.generated).toBe(true);
        expect(address.country).toBe('US');
        expect(address.state).toMatch(/Oregon|Delaware|Montana|New Hampshire|Alaska/);
    });

    it('uses the US pool for the US region too', async () => {
        vi.spyOn(store, 'runQuery').mockResolvedValue([]);

        const address = await pickBillingAddressForCheckout('US', null);

        expect(address.generated).toBe(true);
        expect(address.country).toBe('US');
        expect(address.state).toMatch(/Oregon|Delaware|Montana|New Hampshire|Alaska/);
    });
});
