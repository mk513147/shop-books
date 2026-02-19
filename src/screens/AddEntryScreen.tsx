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
import {
	addTransaction,
	checkExistingEntry,
} from "../database/transactionService";
import { addSupplier } from "../database/supplierService";
import { useNavigation } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";

import { Image } from "react-native";
import { File, Directory, Paths } from "expo-file-system";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Platform } from "react-native";

import { theme } from "../theme";

const mockSuppliers = ["Sharma Steel", "Gupta Traders", "ABC Supplies"];

export default function AddEntryScreen() {
	const [type, setType] = useState<"income" | "expense">("income");
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState("");
	const [supplier, setSupplier] = useState("");
	const [paymentType, setPaymentType] = useState("cash");
	const [note, setNote] = useState("");
	const [images, setImages] = useState<string[]>([]);

	const navigation: any = useNavigation();

	const today = new Date();

	const [selectedDate, setSelectedDate] = useState<Date>(today);
	const [showDatePicker, setShowDatePicker] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	const handleSave = async () => {
		try {
			if (!amount || !category) {
				alert("Amount and Category are required");
				return;
			}

			let supplierId: number | null = null;

			if (type === "expense" && supplier) {
				// Create supplier (simple version for now)
				const result: any = await addSupplier(supplier);
				supplierId = result?.lastInsertRowId ?? null;
			}
			const formattedDate = formatDate(selectedDate);

			const existing = await checkExistingEntry(formattedDate, type);

			if (existing) {
				alert(`An ${type} entry already exists for this date.`);

				setSelectedDate(new Date()); // reset to today
				return;
			}
			await addTransaction({
				type,
				amount: parseFloat(amount),
				category,
				note,
				date: formattedDate,

				paymentType,
				supplierId,
				imagePath: JSON.stringify(images),
			});

			// Reset form
			setAmount("");
			setCategory("");
			setSupplier("");
			setNote("");
			setPaymentType("cash");

			alert("Transaction Saved");

			navigation.goBack();
		} catch (error) {
			console.log(error);
			alert("Error saving transaction");
		}
	};

	const pickImage = async () => {
		if (images.length >= 7) {
			alert("Maximum 7 images allowed");
			return;
		}

		const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

		if (!permission.granted) {
			alert("Permission required");
			return;
		}

		const result = await ImagePicker.launchImageLibraryAsync({
			mediaTypes: ["images"],
			quality: 0.7,
			allowsMultipleSelection: true,
			selectionLimit: 7 - images.length,
		});

		if (!result.canceled) {
			const billsDir = new Directory(Paths.document, "bills");

			if (!(await billsDir.exists)) {
				await billsDir.create({ intermediates: true });
			}

			const newImagePaths: string[] = [];

			for (const asset of result.assets) {
				const fileName = `bill_${Date.now()}_${Math.random()}.jpg`;
				const newFile = new File(billsDir, fileName);

				const sourceFile = new File(asset.uri);
				await sourceFile.copy(newFile);

				newImagePaths.push(newFile.uri);
			}

			setImages((prev) => [...prev, ...newImagePaths]);
		}
	};

	return (
		<ScrollView
			contentContainerStyle={styles.container}
			keyboardShouldPersistTaps="handled"
		>
			{showDatePicker && (
				<DateTimePicker
					value={selectedDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, date) => {
						setShowDatePicker(false);
						if (date) setSelectedDate(date);
					}}
				/>
			)}

			{/* TYPE TOGGLE */}
			<View style={styles.toggleContainer}>
				<TouchableOpacity
					style={[
						styles.toggleButton,
						type === "income" && styles.activeIncome,
					]}
					onPress={() => setType("income")}
				>
					<Text
						style={[
							styles.toggleText,
							{
								color: type === "income" ? "#fff" : theme.colors.textPrimary,
							},
						]}
					>
						Income
					</Text>
				</TouchableOpacity>

				<TouchableOpacity
					style={[
						styles.toggleButton,
						type === "expense" && styles.activeExpense,
					]}
					onPress={() => setType("expense")}
				>
					<Text
						style={[
							styles.toggleText,
							{
								color: type === "expense" ? "#fff" : theme.colors.textPrimary,
							},
						]}
					>
						Expense
					</Text>
				</TouchableOpacity>
			</View>

			<Text style={styles.label}>Date</Text>

			<TouchableOpacity
				style={styles.input}
				onPress={() => setShowDatePicker(true)}
			>
				<Text>{formatDate(selectedDate)}</Text>
			</TouchableOpacity>

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
						<Text
							style={[
								styles.paymentText,
								{
									color: paymentType === p ? "#fff" : theme.colors.textPrimary,
								},
							]}
						>
							{p.toUpperCase()}
						</Text>
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

			{type === "expense" && (
				<>
					<TouchableOpacity style={styles.imageButton} onPress={pickImage}>
						<Ionicons name="camera-outline" size={20} color="#fff" />
						<Text style={styles.imageButtonText}>
							Add Bill Images ({images.length}/7)
						</Text>
					</TouchableOpacity>

					<View style={styles.grid}>
						{images.map((img, index) => (
							<View key={index} style={styles.imageBox}>
								<Image source={{ uri: img }} style={styles.previewImage} />

								<TouchableOpacity
									style={styles.removeImageButton}
									onPress={async () => {
										const file = new File(img);
										await file.delete();

										setImages((prev) => prev.filter((_, i) => i !== index));
									}}
								>
									<Ionicons name="close" size={14} color="#fff" />
								</TouchableOpacity>
							</View>
						))}
					</View>
				</>
			)}

			{/* SAVE BUTTON */}
			<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
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
		marginHorizontal: 4,
		borderWidth: 1,
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.card,
	},

	activeIncome: {
		backgroundColor: theme.colors.income,
		borderColor: theme.colors.income,
	},

	activeExpense: {
		backgroundColor: theme.colors.expense,
		borderColor: theme.colors.expense,
	},

	toggleText: {
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
		fontWeight: "600",
	},

	grid: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginTop: 12,
	},

	imageBox: {
		width: "30%",
		aspectRatio: 1,
		margin: "1.5%",
		position: "relative",
	},

	previewImage: {
		width: "100%",
		height: "100%",
		borderRadius: 8,
	},

	removeImageButton: {
		position: "absolute",
		top: 6,
		right: 6,
		backgroundColor: theme.colors.expense,
		width: 22,
		height: 22,
		borderRadius: 11,
		justifyContent: "center",
		alignItems: "center",
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

	imagePreviewContainer: {
		marginTop: 12,
		position: "relative",
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
