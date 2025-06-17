const express = require("express");
const axios = require("axios");
const { db } = require("../../handlers/db.js");
const { logAudit } = require("../../handlers/auditlog.js");
const { isUserAuthorizedForContainer } = require("../../utils/authHelper");
const { v4: uuid } = require("uuid");

const router = express.Router();

/**
 * POST /instance/reinstall/:id
 * Handles the reinstallment of an existing instance
 */
router.post("/instance/reinstall/:id", async (req, res) => {
    if (!req.user) return res.redirect("/");

    const { id } = req.params;

    if (!id) {
        return res.redirect("/instances");
    }

    try {
        // Get instance data
        const instance = await db.get(`${id}_instance`);
        if (!instance) {
            return res.redirect("/instances");
        }

        // Verify user authorization
        const isAuthorized = await isUserAuthorizedForContainer(
            req.user.userId,
            instance.Id,
        );
        if (!isAuthorized) {
            return res
                .status(403)
                .send("Unauthorized access to this instance.");
        }

        // Check suspension status
        if (instance.suspended === true) {
            return res.redirect("../../instances?err=SUSPENDED");
        }

        // Validate required fields
        const {
            Node: node,
            Image: image,
            Memory: memory,
            Cpu: cpu,
            Ports: ports,
            Name: name,
            User: user,
            Primary: primary,
            ContainerId: containerId,
            Env,
        } = instance;

        if (!image || !memory || !cpu || !name || !user || !primary || !node) {
            return res
                .status(400)
                .json({ error: "Missing required parameters" });
        }

        // Prepare and send reinstall request
        const requestData = await prepareRequestData(
            image,
            memory,
            cpu,
            ports,
            name,
            node,
            id,
            containerId,
            Env,
        );
        const response = await axios(requestData);

        if (!response.data || !response.data.containerId) {
            throw new Error("Invalid response from node");
        }

        // Update database with new instance
        await updateDatabaseWithNewInstance(
            response.data,
            user,
            node,
            image,
            memory,
            cpu,
            ports,
            primary,
            name,
            id,
            Env,
        );

        // Log the action
        await logAudit(
            req.user.userId,
            `Reinstalled instance ${name} (${id})`,
            "instance",
            id,
        );

        res.status(201).redirect(`../../instance/${id}`);
    } catch (error) {
        console.error("Error reinstalling instance:", error);

        // More detailed error handling
        let errorMessage = "Failed to reinstall container";
        if (error.response) {
            errorMessage += `: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
        } else if (error.request) {
            errorMessage += ": No response received from node";
        } else {
            errorMessage += `: ${error.message}`;
        }

        res.status(500).json({
            error: errorMessage,
            details: error.stack,
        });
    }
});

async function prepareRequestData(
    image,
    memory,
    cpu,
    ports,
    name,
    node,
    id,
    containerId,
    Env,
) {
    try {
        const rawImages = (await db.get("images")) || [];
        const imageData = rawImages.find((i) => i.Image === image);

        const requestData = {
            method: "post",
            url: `http://${node.address}:${node.port}/instances/reinstall/${containerId}`,
            auth: {
                username: "Skyport",
                password: node.apiKey,
            },
            headers: {
                "Content-Type": "application/json",
                "X-Request-ID": uuid(),
            },
            timeout: 30000, // 30 seconds timeout
            data: {
                Name: name,
                Id: id,
                Image: image,
                Env: Env || {},
                Scripts: imageData?.Scripts,
                Memory: parseInt(memory) || 512,
                Cpu: parseInt(cpu) || 100,
                ExposedPorts: {},
                PortBindings: {},
                AltImages: imageData?.AltImages || [],
                imageData: imageData || {},
            },
        };

        // Handle port mappings if they exist
        if (ports && typeof ports === "string") {
            ports.split(",").forEach((portMapping) => {
                const [containerPort, hostPort] = portMapping
                    .split(":")
                    .map((p) => p.trim());
                if (containerPort && hostPort) {
                    const key = `${containerPort}/tcp`;
                    requestData.data.ExposedPorts[key] = {};
                    requestData.data.PortBindings[key] = [
                        { HostPort: hostPort },
                    ];
                }
            });
        }

        return requestData;
    } catch (error) {
        console.error("Error preparing request data:", error);
        throw new Error(`Failed to prepare request data: ${error.message}`);
    }
}

async function updateDatabaseWithNewInstance(
    responseData,
    userId,
    node,
    image,
    memory,
    cpu,
    ports,
    primary,
    name,
    id,
    Env,
) {
    try {
        const rawImages = (await db.get("images")) || [];
        const imageData = rawImages.find((i) => i.Image === image);

        const instanceData = {
            Name: name,
            Id: id,
            Node: node,
            User: userId,
            ContainerId: responseData.containerId,
            VolumeId: id,
            Memory: parseInt(memory) || 512,
            Cpu: parseInt(cpu) || 100,
            Ports: ports,
            Primary: primary,
            Image: image,
            AltImages: imageData?.AltImages || [],
            imageData: imageData || {},
            Env: Env || {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        // Update user instances
        let userInstances = (await db.get(`${userId}_instances`)) || [];
        userInstances = userInstances.filter((instance) => instance.Id !== id);
        userInstances.push(instanceData);
        await db.set(`${userId}_instances`, userInstances);

        // Update global instances
        let globalInstances = (await db.get("instances")) || [];
        globalInstances = globalInstances.filter(
            (instance) => instance.Id !== id,
        );
        globalInstances.push(instanceData);
        await db.set("instances", globalInstances);

        // Update individual instance record
        await db.set(`${id}_instance`, instanceData);

        // Add audit log
        await logAudit(
            userId,
            `Updated instance ${name} (${id}) in database`,
            "database",
            id,
        );
    } catch (error) {
        console.error("Error updating database:", error);
        throw new Error(`Failed to update database: ${error.message}`);
    }
}

module.exports = router;
