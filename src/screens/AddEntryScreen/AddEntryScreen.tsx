import React, { useEffect, useCallback, useState } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	ScrollView,
	Image,
	Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Picker } from "@react-native-picker/picker";

import { incomeCategories, expenseCategories } from "@constants/categories";
import {
	addTransaction,
	checkExpenseSupplierSameDay,
	checkIncomeCategorySameDay,
	getDailyTransactionCount,
	getTransactionsByDate,
	updateTransaction,
} from "@database/transactionService";
import { getOrCreateSupplier, getSuppliers } from "@database/supplierService";
import { File, Directory, Paths } from "expo-file-system";

import * as ImagePicker from "expo-image-picker";
import DateTimePicker from "@react-native-community/datetimepicker";

import {
	useRoute,
	RouteProp,
	useFocusEffect,
	useNavigation,
} from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RootStackParamList } from "@navigation/types";

import { styles } from "./AddEntry.styles";
import { theme } from "@theme";
import DraggableBottomSheet from "@components/DraggableBottomSheet";

type Supplier = {
	id: number;
	name: string;
};

type RouteProps = RouteProp<RootStackParamList, "AddEntry">;

type NavigationProp = NativeStackNavigationProp<RootStackParamList, "AddEntry">;

export default function AddEntryScreen() {
	const route = useRoute<RouteProps>();
	const editingTransaction = route.params?.transaction ?? null;
	const isEditMode = !!editingTransaction;

	const [type, setType] = useState<"income" | "expense">("income");
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState("");
	const [supplier, setSupplier] = useState("");

	const [suppliers, setSuppliers] = useState<Supplier[]>([]);

	const [paymentType, setPaymentType] = useState("cash");
	const [note, setNote] = useState("");

	const [images, setImages] = useState<string[]>([]);

	const [dailyTransactions, setDailyTransactions] = useState<any[]>([]);

	const navigation = useNavigation<NavigationProp>();

	const today = new Date();
	const [selectedDate, setSelectedDate] = useState<Date>(today);
	const [showDatePicker, setShowDatePicker] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	const loadSuppliers = async () => {
		const dbSuppliers = await getSuppliers();
		setSuppliers(dbSuppliers as Supplier[]);
	};

	const loadDailyTransactions = async () => {
		const formattedDate = formatDate(selectedDate);
		const data = await getTransactionsByDate(formattedDate);
		setDailyTransactions(data);
	};

	const handleSave = async () => {
		try {
			if (!amount || !category) {
				alert("Amount and Category are required");
				return;
			}

			const numericAmount = parseFloat(amount);

			if (isNaN(numericAmount) || numericAmount <= 0) {
				alert("Enter a valid amount");
				return;
			}

			if (type === "expense" && !supplier) {
				alert("Supplier is required for expense.");
				return;
			}

			const formattedDate = formatDate(selectedDate);

			// 1️⃣ Daily limit
			if (!isEditMode) {
				const count = await getDailyTransactionCount(formattedDate, type);

				if (count >= 12) {
					alert(`Maximum 12 ${type} entries allowed per day.`);
					return;
				}
			}

			// 2️⃣ Income duplicate category same day
			if (type === "income") {
				const existingCategory = await checkIncomeCategorySameDay(
					formattedDate,
					category,
					editingTransaction?.id,
				);

				if (existingCategory) {
					alert(`Income category "${category}" already exists for this date.`);
					return;
				}
			}

			let supplierId: number | null = null;

			// 3️⃣ Expense supplier duplicate same day
			if (type === "expense") {
				supplierId = await getOrCreateSupplier(supplier);

				const existingSupplier = await checkExpenseSupplierSameDay(
					formattedDate,
					supplierId,
					editingTransaction?.id,
				);

				if (existingSupplier) {
					alert(
						`Expense for supplier "${supplier}" already exists for this date.`,
					);
					return;
				}
			}

			// 4️⃣ Insert
			if (isEditMode) {
				await updateTransaction(editingTransaction.id, {
					type,
					amount: numericAmount,
					category,
					note,
					date: formattedDate,
					paymentType,
					supplierId,
					imagePath: JSON.stringify(images),
				});

				alert("Transaction Updated");
				await loadDailyTransactions();
				navigation.goBack();
			} else {
				await addTransaction({
					type,
					amount: numericAmount,
					category,
					note,
					date: formattedDate,
					paymentType,
					supplierId,
					imagePath: JSON.stringify(images),
				});

				setAmount("");
				setCategory("");
				setSupplier("");
				setNote("");
				setPaymentType("cash");
				setImages([]);

				alert("Transaction Saved");
				await loadDailyTransactions();
			}
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

	const incomeList = dailyTransactions.filter((t) => t.type === "income");

	const expenseList = dailyTransactions.filter((t) => t.type === "expense");

	const incomeTotal = incomeList.reduce(
		(sum, t) => sum + Number(t.amount || 0),
		0,
	);

	const expenseTotal = expenseList.reduce(
		(sum, t) => sum + Number(t.amount || 0),
		0,
	);

	useFocusEffect(
		useCallback(() => {
			loadDailyTransactions();
			loadSuppliers();
		}, [selectedDate]),
	);

	useEffect(() => {
		if (editingTransaction) {
			setType(editingTransaction.type);
			setAmount(String(editingTransaction.amount));
			setCategory(editingTransaction.category ?? "");
			setSupplier(editingTransaction.supplierName ?? "");
			setPaymentType(editingTransaction.paymentType ?? "cash");
			setNote(editingTransaction.note ?? "");
			setSelectedDate(new Date(editingTransaction.date));

			if (editingTransaction.imagePath) {
				setImages(JSON.parse(editingTransaction.imagePath));
			}
		}
	}, [editingTransaction]);

	useEffect(() => {
		if (type === "income") {
			setSupplier("");
		}
	}, [type]);

	return (
		<View style={styles.container}>
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
			<View style={styles.formSection}>
				{/* TYPE TOGGLE */}
				<ScrollView
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={{ paddingBottom: 90 }}
				>
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
										color:
											type === "income" ? "#fff" : theme.colors.textPrimary,
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
										color:
											type === "expense" ? "#fff" : theme.colors.textPrimary,
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
									{suppliers.map((sup) => (
										<Picker.Item
											key={sup.id}
											label={sup.name}
											value={sup.name}
										/>
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
											color:
												paymentType === p ? "#fff" : theme.colors.textPrimary,
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
						<Text style={styles.saveButtonText}>
							{isEditMode ? "Update Entry" : "Save Entry"}
						</Text>
					</TouchableOpacity>
				</ScrollView>
			</View>

			{/* SUMMARY SECTION*/}
			<DraggableBottomSheet>
				<Text style={styles.panelTitle}>Today's Summary</Text>

				<ScrollView
					showsVerticalScrollIndicator={false}
					contentContainerStyle={{ paddingBottom: 20 }}
				>
					{/* Income */}
					{incomeList.length > 0 && (
						<>
							<Text style={styles.subHeading}>Income</Text>
							{incomeList.map((item) => (
								<TouchableOpacity
									key={item.id}
									style={styles.row}
									onPress={() =>
										navigation.navigate("TransactionDetail", {
											transaction: item,
										})
									}
								>
									<Text>{item.category}</Text>
									<Text>₹{item.amount}</Text>
								</TouchableOpacity>
							))}

							<View style={styles.totalRow}>
								<Text>Total</Text>
								<Text>₹{incomeTotal}</Text>
							</View>
						</>
					)}

					{/* Expense */}
					{expenseList.length > 0 && (
						<>
							<Text style={[styles.subHeading, { marginTop: 16 }]}>
								Expense
							</Text>
							{expenseList.map((item) => (
								<TouchableOpacity
									key={item.id}
									style={styles.row}
									onPress={() =>
										navigation.navigate("TransactionDetail", {
											transaction: item,
										})
									}
								>
									<Text>{item.supplierName}</Text>
									<Text>₹{item.amount}</Text>
								</TouchableOpacity>
							))}
							<View style={styles.totalRow}>
								<Text>Total</Text>
								<Text>₹{expenseTotal}</Text>
							</View>
						</>
					)}
				</ScrollView>
			</DraggableBottomSheet>
		</View>
	);
}
