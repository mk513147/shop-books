import React, { useState } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	StyleSheet,
	ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Picker } from "@react-native-picker/picker";
import { incomeCategories, expenseCategories } from "../constants/categories";

import { theme } from "../theme";

const mockSuppliers = ["Sharma Steel", "Gupta Traders", "ABC Supplies"];

export default function AddEntryScreen() {
	const [type, setType] = useState<"income" | "expense">("income");
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState("");
	const [supplier, setSupplier] = useState("");
	const [paymentType, setPaymentType] = useState("cash");
	const [note, setNote] = useState("");

	return (
		<ScrollView
			contentContainerStyle={styles.container}
			keyboardShouldPersistTaps="handled"
		>
			{/* TYPE TOGGLE */}
			<View style={styles.toggleContainer}>
				<TouchableOpacity
					style={[
						styles.toggleButton,
						type === "income" && styles.activeIncome,
					]}
					onPress={() => setType("income")}
				>
					<Text style={styles.toggleText}>Income</Text>
				</TouchableOpacity>

				<TouchableOpacity
					style={[
						styles.toggleButton,
						type === "expense" && styles.activeExpense,
					]}
					onPress={() => setType("expense")}
				>
					<Text style={styles.toggleText}>Expense</Text>
				</TouchableOpacity>
			</View>

			{/* AMOUNT */}
			<Text style={styles.label}>Amount</Text>
			<TextInput
				style={styles.amountInput}
				keyboardType="numeric"
				placeholder="₹ 0.00"
				value={amount}
				onChangeText={setAmount}
			/>

			{/* CATEGORY */}
			<Text style={styles.label}>Category</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={category}
					onValueChange={(itemValue) => setCategory(itemValue)}
				>
					<Picker.Item label="Select Category" value="" />
					{(type === "income" ? incomeCategories : expenseCategories).map(
						(cat) => (
							<Picker.Item key={cat} label={cat} value={cat} />
						),
					)}
				</Picker>
			</View>

			{/* SUPPLIER (only for expense) */}
			{type === "expense" && (
				<>
					<Text style={styles.label}>Supplier</Text>
					<View style={styles.pickerWrapper}>
						<Picker
							selectedValue={supplier}
							onValueChange={(itemValue) => setSupplier(itemValue)}
						>
							<Picker.Item label="Select Supplier" value="" />
							{mockSuppliers.map((sup) => (
								<Picker.Item key={sup} label={sup} value={sup} />
							))}
						</Picker>
					</View>
				</>
			)}

			{/* PAYMENT TYPE */}
			<Text style={styles.label}>Payment Type</Text>
			<View style={styles.paymentRow}>
				{["cash", "online", "due"].map((p) => (
					<TouchableOpacity
						key={p}
						style={[
							styles.paymentButton,
							paymentType === p && styles.paymentActive,
						]}
						onPress={() => setPaymentType(p)}
					>
						<Text style={styles.paymentText}>{p.toUpperCase()}</Text>
					</TouchableOpacity>
				))}
			</View>

			{/* NOTE */}
			<Text style={styles.label}>Note</Text>
			<TextInput
				style={[styles.input, { height: 80 }]}
				placeholder="Optional note"
				value={note}
				onChangeText={setNote}
				multiline
			/>

			{/* BILL IMAGE BUTTON */}
			<TouchableOpacity style={styles.imageButton}>
				<Ionicons name="camera-outline" size={20} color="#fff" />
				<Text style={styles.imageButtonText}> Add Bill Image</Text>
			</TouchableOpacity>

			{/* SAVE BUTTON */}
			<TouchableOpacity style={styles.saveButton}>
				<Text style={styles.saveButtonText}>Save Entry</Text>
			</TouchableOpacity>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: {
		padding: 16,
		backgroundColor: theme.colors.background,
	},

	toggleContainer: {
		flexDirection: "row",
		marginBottom: 20,
	},

	toggleButton: {
		flex: 1,
		padding: 14,
		alignItems: "center",
		borderRadius: 8,
		backgroundColor: theme.colors.card,
		marginHorizontal: 4,
	},

	activeIncome: {
		backgroundColor: theme.colors.income,
	},

	activeExpense: {
		backgroundColor: theme.colors.expense,
	},

	toggleText: {
		color: "#fff",
		fontWeight: "600",
	},

	label: {
		marginTop: 16,
		marginBottom: 6,
		color: theme.colors.textPrimary,
		fontSize: 14,
	},

	amountInput: {
		backgroundColor: theme.colors.card,
		padding: 18,
		fontSize: 26,
		fontWeight: "700",
		borderRadius: 10,
	},

	input: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 8,
	},

	paymentRow: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	paymentButton: {
		flex: 1,
		padding: 12,
		marginHorizontal: 4,
		borderRadius: 8,
		alignItems: "center",
		borderWidth: 1,
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.card,
	},

	paymentActive: {
		backgroundColor: theme.colors.primary,
		borderColor: theme.colors.primary,
	},

	paymentText: {
		color: "#fff",
		fontWeight: "600",
	},

	imageButton: {
		marginTop: 20,
		flexDirection: "row",
		backgroundColor: theme.colors.primary,
		padding: 14,
		borderRadius: 8,
		justifyContent: "center",
		alignItems: "center",
	},

	imageButtonText: {
		color: "#fff",
		fontWeight: "600",
	},

	saveButton: {
		marginTop: 24,
		backgroundColor: theme.colors.primary,
		padding: 16,
		borderRadius: 10,
		alignItems: "center",
	},

	saveButtonText: {
		color: "#fff",
		fontSize: 16,
		fontWeight: "700",
	},
	pickerWrapper: {
		backgroundColor: theme.colors.card,
		borderRadius: 8,
	},
});
