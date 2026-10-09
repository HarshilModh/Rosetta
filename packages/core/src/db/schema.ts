import { pgTable, text, timestamp, integer, boolean, jsonb, vector,pgEnum } from "drizzle-orm/pg-core";

export const userQuotas = pgTable('user_quotas',{
    userId: text("user_id").primaryKey(),
    dailyCap: integer("daily_cap").default(1400).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const projects = pgTable('projects',{
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    TargetUrl:text("target_url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    
});
