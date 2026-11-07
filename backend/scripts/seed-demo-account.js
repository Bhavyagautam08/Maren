import mongoose from "mongoose";
import { MONGO_URI } from "../src/config/env.js";
import User from "../src/models/user.model.js";
import { passwordHashing } from "../src/services/user.service.js";

const email = process.env.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase();
const password = process.env.DEMO_ACCOUNT_PASSWORD;

const seedDemoAccount = async () => {
    if (!MONGO_URI) {
        throw new Error("MONGO_URI must be configured in backend/.env.");
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.example$/.test(email)) {
        throw new Error("DEMO_ACCOUNT_EMAIL must be a valid address in the reserved .example domain.");
    }
    if (!password || password.length < 6 || password.length > 50) {
        throw new Error("DEMO_ACCOUNT_PASSWORD must be between 6 and 50 characters.");
    }

    await mongoose.connect(MONGO_URI);
    const hashedPassword = await passwordHashing(password);
    const user = await User.findOneAndUpdate(
        { email },
        {
            $set: {
                name: "Demo Customer",
                email,
                age: 30,
                gender: "not to say",
                password: hashedPassword,
                role: "user"
            }
        },
        {
            new: true,
            upsert: true,
            runValidators: true
        }
    );

    console.log(`Demo customer is ready: ${user.email} (role: ${user.role}).`);
};

seedDemoAccount()
    .catch((error) => {
        console.error("Could not seed the demo account:", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect();
    });
