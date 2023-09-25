import PromptSync from "prompt-sync";
import puppeteer from "puppeteer";
import fetch from "node-fetch";
import yargs from "yargs";
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";

const prompt = PromptSync();

const argv = yargs(process.argv.slice(2))
    .option("username", {
        alias: "u",
        type: "string",
        description: "Your username",
    })
    .option("password", {
        alias: "p",
        type: "string",
        description: "Your password",
    })
    .option("ean", {
        alias: "e",
        type: "string",
        description: "EAN of the product",
    })
    .option("output", {
        alias: "o",
        type: "string",
        description: "Output file name (without extension)",
    })
    .help()
    .alias("help", "h").argv;


(async () => {
    let username = argv.username;

    while (!username)
        username = prompt("Username/email: ");

    let password = argv.password;

    while (!password)
        password = prompt.hide("Password (hidden): ");

    let auth = await fetch("https://exobank.hachette-livre.fr/api/exoauth/authorize", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic a2V5MTIzOnNlY3JldDEyMw==" // decode this base64 for a laugh 
        },
        body: JSON.stringify({
            username,
            password,
            authMethod: "pne",
            appId: "educadhoc_v9_online_2u9Au4NbBCm9Ez",
        }),
    }).then(res => res.json()).catch(err => {
        console.error("Unable to login", err);
        process.exit(1);
    });

    let token = await fetch("https://exobank.hachette-livre.fr/api/exoauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic a2V5MTIzOnNlY3JldDEyMw=="
        },
        body: JSON.stringify({
            authToken: auth.data.authToken,
        }),
    }).then(res => res.json()).catch(err => {
        console.error("Unable to get token", err);
        process.exit(1);
    });

    console.log("Logged in as " + token.data.userId.firstname + " " + token.data.userId.lastname);

    let ean = argv.ean;

    while (!ean)
        ean = prompt("EAN: ");

    console.log("Getting book data");

    let bank = await fetch("https://exobank.hachette-livre.fr/api/bankdata/bank?ean=" + ean, {
        headers: {
            "Authorization": "Bearer " + token.data.userToken,
        },
    }).then(res => res.json()).catch(err => {
        console.error("Unable to get bank", err);
        process.exit(1);
    });

    let summary = await fetch("https://exobank.hachette-livre.fr/api/bankdata/summary?bankId=" + bank.data[0]._id, {
        headers: {
            "Authorization": "Bearer " + token.data.userToken,
        },
    }).then(res => res.json()).catch(err => {
        console.error("Unable to get summary", err);
        process.exit(1);
    });

    let browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
    });

    let renderingPage = await browser.newPage();

    let pdfMerger = await PDFDocument.create();

    let pages = summary.data.find((e) => e.section == "spine-fxl").children;

    console.log("Downloading " + pages.length + " pages");

    for (let i = 0; i < pages.length; i++) {
        let page = pages[i];

        let type = page.metaData.find((d) => d.key == "type").value;

        if (type == "image/jpeg") {
            let data = await fetch("https://exobank.hachette-livre.fr/" + page.link.content).then(res => res.arrayBuffer());

            let img = await pdfMerger.embedJpg(data);

            let pdfPage = pdfMerger.addPage([img.width, img.height]);

            pdfPage.drawImage(img, {
                x: 0,
                y: 0,
            });
        } else if (type == "application/xhtml+xml") {
            await renderingPage.goto("https://exobank.hachette-livre.fr/" + page.link.content);

            let sizeMeta = await renderingPage.$eval("head > meta[name='viewport']", element => element.content);

            let splitSize = sizeMeta.split(",");
            let width = parseInt(splitSize[0].split("=")[1]);
            let height = parseInt(splitSize[1].split("=")[1]);
            
            renderingPage.setViewport({
                width,
                height,
            });

            let pdfContent = await renderingPage.pdf({
                width,
                height,
            });

            let pdfDoc = await PDFDocument.load(pdfContent);

            let [copiedPage] = await pdfMerger.copyPages(pdfDoc, [0]);

            pdfMerger.addPage(copiedPage);
        } else {
            console.error("Unknown type " + type + " for page " + i + " please report it on the github page");
        }

        console.log("Downloaded page " + (i + 1) + "/" + pages.length + " (" + (i / pages.length * 100).toFixed(2) + "%)");
    }

    await browser.close();

    // removing all links from pdf since they are all broken
    pdfMerger.getPages().forEach((p) => {
        p.node.Annots()?.asArray().forEach((a) => {
            pdfMerger.context.delete(a)
        })
    })

    console.log("Saving PDF");

    let pdfBytes = await pdfMerger.save();

    await fs.writeFile((argv.output || bank.data[0].name || bank.data[0].ean) + ".pdf", pdfBytes);

    console.log("Done, saved as " + (argv.output || bank.data[0].name || bank.data[0].ean) + ".pdf" );

})();