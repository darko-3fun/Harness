# HARNESS — demo za žiri (~3 min)

Sve brojke dole su izmerene, ne procenjene. Ako te pitaju „kako znaš" — odgovor je
u poslednjoj sekciji.

---

## 0. Otvaranje (20 s)

> „DeFi hakovi se ponavljaju. Isti bag, drugi protokol — callback koji nije zatvoren,
> zaokruživanje koje ide u pogrešnu stranu. HARNESS generiše Solidity kod u kome su ti
> napadi već zatvoreni, i uz njega generiše testove koji to dokazuju na pravom mainnet
> forku. Ne na mocku — na pravom Aave-u i pravom Morpho-u."

---

## 1. Generisanje (30 s)

**Otvori padajući meni `Vaults` i izaberi `Aave V3 Vault`. Pokaži opcije sa strane.**

> „Tri kategorije: vaultovi nad Aave-om, Morpho-om i Compound-om, launchpadi — fiksna
> prodaja tokena i bonding curve koja završava u pravom Uniswap V2 pool-u — i Aave
> flash-loan receiver. Šest preseta, svaki vezan za konkretne hakove."


> „Biramo preset i podesimo opcije: kontrola pristupa, pauza, deposit cap, decimals
> offset. Kod se prepisuje dok kucaš."

**Klikni kroz tabove fajlova.**

> „Četiri fajla odmah: ugovor, attack testovi, property testovi, deploy skripta. Ovo nije LLM koji piše kod —
> ovo je deterministički generator. Isti ulaz uvek daje isti izlaz, i svaka opcija koja
> bi napravila nesiguran ugovor se odbija umesto da se generiše."

---

## 2. Audit (30 s)

**Klikni `Audit`.**

> „Audit prolazi kroz katalog od 38 nalaza, svaki vezan za konkretan incident sa linkom.
> Na generisanom kodu je sve zeleno — i to je poenta: pravilo koje se nikad ne okine
> izgleda isto kao pravilo koje radi."

**Obriši `using SafeERC20 for IERC20;` iz editora, pa opet klikni `Audit`.**

> „Zato smo svako pravilo mutaciono testirali. Sklonim jednu zaštitu — okine se tačno
> jedan nalaz, onaj pravi, i nijedan drugi. I audit gleda kod, ne tekst: komentari i
> stringovi se maskiraju pre provere, pa zaštita koja postoji samo u komentaru ne prolazi."

*(Ovo je jak trenutak. Sačekaj sekundu da žiri vidi crveno.)*

---

## 2b. Zašto dva test fajla (30 s) ⭐

**Klikni tab `Properties`. Otvori se panel sa strane.**

> „Testovi koji samo proveravaju kod koji smo mi napisali bili bi dekoracija — generisani
> ugovor ih prolazi po konstrukciji. Zato svaki download nosi dva fajla sa dva različita
> posla. Attack testovi su regresija za zaštite: obrišeš zaštitu, pukne test koji je
> imenuje. Property testovi su za ono što korisnik DODA: fuzz i invarijante koje moraju da
> važe za bilo koju strategiju ili feature nadograđen na ugovor — nikad ne izvučeš više
> nego što si uložio, donacija ne pomera cenu, knjiga nikad ne premaši poziciju na tržištu,
> svako uvek može da izađe."

> „Ti testovi su nam sami našli bag u našem Aave vaultu pre nego što je isporučen: Aave
> zaokružuje scaled balance i knjiga je mogla da bude jedan wei iznad pozicije, što obara
> poslednjeg ko izlazi. Popravljeno u generatoru."


---

## 3. Morpho — zašto fork, a ne mock (45 s) ⭐

**Prebaci preset na `Morpho Blue Vault`.**

> „Dodali smo i Morpho Blue. To nije Aave sa drugom adresom — Morpho ima tri zamke koje
> Aave nema. Najzanimljivija: Morpho prima i `assets` i `shares`, i tačno jedan mora biti
> nula."

> „Kad smo pustili testove na forku, pali su. Morpho pri ulogu konvertuje assets u shares
> zaokružujući **naniže**, a pri isplati nazad zaokružujući **naviše**. Znači ako
> proknjižiš iznos koji si tražio, vault misli da ima više nego što stvarno može da
> isplati — i poslednji čovek koji izlazi ne može da izađe. Transakcija puca **unutar
> Morpho ugovora**, ne u našem."

> „Taj bag ne postoji ni na jednom mocku. Našli smo ga samo zato što testovi idu na pravi
> mainnet. Popravka: knjižimo razliku koju izmerimo, ne iznos koji smo tražili."

---

## 4. Preuzimanje i pokretanje (30 s)

**Klikni `Download`.**

> „Dobijaš kompletan Foundry projekat: `setup.sh` povuče zavisnosti, `forge test` pokrene
> napade. Testirali smo iz čistog foldera — raspakuj, pokreni, prolazi."

**Ako imaš terminal spreman, pusti `forge test`. Ako ne, pokaži screenshot.**

> „Devedeset sedam testova ukupno kroz šest preseta, svi zeleni na mainnet forku —
> uključujući graduaciju bonding curve-a u pravi Uniswap V2 pool. I to za bilo koji asset:
> isti paket prolazi i za USDC i za WETH."

---

## 4b. Compound i launchpadi (30 s)

**Prebaci na `Compound V3 Vault`, pa na `Launchpads → Bonding Curve`.**

> „Compound v3 ima zamku koju ni Aave ni Morpho nemaju: `withdraw` preko balansa tiho
> otvara borrow, a kolateral vaultu može da pokloni bilo ko. Vault ograničava svaki
> withdraw na poziciju i proverava da dug ostane nula."

> „Bonding curve: tokeni su zaključani do graduacije — to je Four.meme bag iz 2025,
> dva puta. Likvidnost se mintuje direktno na pair-u, ne kroz router, pa unapred
> nasađen pool ne može da odredi cenu. LP ide na dead adresu. Vlasnik ne može da dođe do
> rezervi ni na koji način — to je ono što je pump.fun insajder iskoristio."

---

## 5. MCP (20 s)

> „I sve ovo je dostupno preko MCP servera — znači Claude ili bilo koji AI agent može da
> generiše i auditira ugovor direktno, bez browsera. Isti API koji koristi sajt."

---

## 6. Zatvaranje (15 s)

> „Da rezimiram: generator koji ne može da napravi nesiguran ugovor, audit čija su pravila
> dokazano funkcionalna, i testovi koji su nam našli pravi bag u pravom protokolu."

---

## Ako pitaju „kako znate da radi?"

| Tvrdnja | Dokaz |
|---|---|
| Testovi rade | 97/97 na mainnet forku kroz šest preseta; ista četiri asset-vezana preseta i sa WETH-om: 64/64 |
| Generator ne pravi smeće | Nesigurne kombinacije se odbijaju sa porukom po polju, ne generišu |
| Kod se kompajlira | Svih šest preseta, solc 0.8.27, 0 grešaka, 0 warninga |
| Audit pravila stvarno rade | 38 nalaza, 53 mutacije — svaka se okine tačno na svoj nalaz i ni na jedan tuđi |
| Download radi | Čist unzip → `setup.sh` → `forge test` → prolazi, za svih šest preseta |

## Ako pitaju „šta ne radi još?"

Budi iskren, to ostavlja bolji utisak nego izbegavanje:

> „Deploy i simulacija kroz Tenderly žive u `harness-api` i traže sopstveni Virtual
> Environment — onaj na kome je projekat pravljen je sada rate-limited. Sve ostalo —
> generisanje, audit, savetnik za sva tri tržišta, export, MCP — radi bez ključeva."

---

## Ako pitaju „šta ako promenim asset?"

Ovo je dobro pitanje da ti postave — imaš jak odgovor.

> „Zavisi od protokola, i baš to alat pokazuje.
>
> Na Aave-u promeniš asset i savetnik te prati sam — Aave rezervu identifikuje
> adresa tokena, jedan token je jedna rezerva. WETH: druge decimale, drugi cap,
> drugi APY, i preporuka za offset se menja jer zavisi od decimala.
>
> Na Morpho-u drugačije. Morpho market **nije** token — market je hash pet parametara:
> loan token, kolateral, oracle, IRM i LLTV. Isti USDC postoji u više Morpho
> marketa sa različitim oracle-om i različitim LLTV-om. Zato „promeni asset" na
> Morpho-u znači „izaberi drugi market".
>
> Zato vault pinuje market u konstruktoru, a alat nosi katalog najdubljih živih
> marketa po assetu: promeniš asset na WETH i dobiješ picker sa wstETH/WETH marketima
> i njihovim LLTV-om. Testovi, deploy skripta i savetnik svi gledaju u taj isti market —
> to je nalaz MRPH-MKT-018 sproveden kroz ceo alat, ne samo kroz ugovor. Asset bez
> kataloškog marketa se odbija umesto da se tiho analizira pogrešan market."

**Ako pritisnu „a kako onda menjam Morpho market?":**

> „Konstruktor prima svih pet parametara, pa market biraš pri deployu. Ono što ne
> možeš je da ga promeniš posle — nema settera, i test `test_MarketParamsArePinned`
> to proverava."

*(Demo: prebaci asset na WETH dok si na Morpho presetu — pojavi se picker marketa,
ugovor, testovi i savetnik prate izbor. Izaberi WBTC — generator odbije sa porukom,
jer nema kataloškog marketa. Odbijanje je funkcija, ne ograničenje.)*

## Tehnički detalji za potpitanja

- **Zašto nije LLM?** Determinizam. Generator je čista funkcija; isti ulaz → isti izlaz,
  i može da odbije nesiguran ulaz. LLM ne može da garantuje ni jedno ni drugo.
- **Odakle nalazi?** Svaki je vezan za konkretan incident — Code4rena, Sherlock, ili
  dokumentacija protokola. Linkovi su u samim komentarima generisanog testa.
- **Zašto Tenderly?** Treba nam archive node da bismo fiksirali blok. Bez fiksiranog bloka
  test koji je danas zelen sutra pukne bez ikakve promene u kodu.
- **Morpho market:** nije izmišljen — pronađen skeniranjem `CreateMarket` logova i rangiran
  po slobodnoj likvidnosti. WBTC/USDC, 86% LLTV.
